require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const path = require('path');
const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const port = Number(process.env.PORT || 3000);
const bucketName = process.env.B2_BUCKET_NAME;
const endpoint = process.env.B2_ENDPOINT;
const region = process.env.B2_REGION || 'us-east-005';
const accessKeyId = process.env.B2_KEY_ID;
const secretAccessKey = process.env.B2_APPLICATION_KEY;
const prefix = (process.env.B2_PREFIX ?? 'roms').replace(/^\/+|\/+$/g, '');

if (!bucketName || !endpoint || !accessKeyId || !secretAccessKey) {
  console.warn('Faltan variables de entorno de Backblaze B2. Revisa .env o .env.example');
}

const s3Client = new S3Client({
  region,
  endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});
const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const CORE_MAP = {
  nes: 'nes', fds: 'nes', sfc: 'snes', smc: 'snes', gb: 'gb', gbc: 'gb', gba: 'gba',
  md: 'segaMD', gen: 'segaMD', smd: 'segaMD', n64: 'n64', z64: 'n64', v64: 'n64',
  nds: 'nds', '3ds': '3ds', cci: '3ds', cxi: '3ds',
  cue: 'psx', iso: 'psx', pbp: 'psx', chd: 'psx',
};
const VALID_CORES = new Set(['nes', 'snes', 'gb', 'gba', 'segaMD', 'n64', 'nds', '3ds', 'psx']);

function inferCore(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return CORE_MAP[ext] || 'auto';
}

function coreFromKey(key) {
  const prefixPath = `${prefix}/`;
  const relativeKey = key.startsWith(prefixPath) ? key.slice(prefixPath.length) : key;
  const [directory, ...remaining] = relativeKey.split('/');
  if (remaining.length && VALID_CORES.has(directory)) return directory;
  return inferCore(relativeKey.split('/').pop());
}

function cleanKey(value) {
  return String(value || '').replace(/^\/+/, '').replace(/\\/g, '/');
}

function coverPrefix() {
  return `${prefix ? `${prefix}/` : ''}covers/`;
}

function metadataKey() {
  return `${prefix ? `${prefix}/` : ''}__emuapp/rom-metadata.json`;
}

function playCountsKey() {
  return `${prefix ? `${prefix}/` : ''}__emuapp/rom-play-counts.json`;
}

function coverKeyForRom(romKey) {
  const hash = crypto.createHash('sha256').update(romKey).digest('hex');
  return `${coverPrefix()}${hash}`;
}

let romMetadataCache;
let playCountWriteQueue = Promise.resolve();

async function getRomMetadata() {
  if (romMetadataCache) return romMetadataCache;

  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: metadataKey(),
    }));
    const metadata = JSON.parse(await response.Body.transformToString());
    if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') {
      throw new Error('El índice de sistemas de ROMs no tiene un formato válido');
    }
    romMetadataCache = metadata;
    return romMetadataCache;
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      romMetadataCache = {};
      return romMetadataCache;
    }
    throw error;
  }
}

async function getRomPlayCounts() {
  try {
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: bucketName,
      Key: playCountsKey(),
    }));
    const counts = JSON.parse(await response.Body.transformToString());
    if (!counts || Array.isArray(counts) || typeof counts !== 'object' ||
        Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0)) {
      throw new Error('El índice de partidas no tiene un formato válido');
    }
    return counts;
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return {};
    }
    throw error;
  }
}

function incrementRomPlayCount(romKey) {
  const operation = playCountWriteQueue.then(async () => {
    const counts = await getRomPlayCounts();
    const currentPlayCount = Object.prototype.hasOwnProperty.call(counts, romKey) ? counts[romKey] : 0;
    const playCount = currentPlayCount + 1;
    if (!Number.isSafeInteger(playCount)) {
      throw new Error('El contador de partidas alcanzó su límite');
    }
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: playCountsKey(),
      Body: JSON.stringify({ ...counts, [romKey]: playCount }),
      ContentType: 'application/json',
    }));
    return playCount;
  });
  playCountWriteQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function isRomKey(key) {
  const root = prefix ? `${prefix}/` : '';
  return key.length > root.length &&
    key.startsWith(root) &&
    !key.startsWith(coverPrefix()) &&
    !key.startsWith(`${root}__emuapp/`) &&
    !key.endsWith('/') &&
    !key.toLowerCase().endsWith('/.bzempty');
}

function sanitizeFileName(name = 'rom') {
  return String(name).replace(/[<>:"/\\|?*]+/g, '_');
}

async function signUrl(key) {
  const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
  return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

if (process.env.NODE_ENV !== 'production') {
  app.use(express.static(path.join(__dirname)));
}
const allowedOrigins = new Set(
  (process.env.CORS_ORIGIN || '').split(',').map(origin => origin.trim()).filter(Boolean)
);
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin');
  if (origin && allowedOrigins.size && !allowedOrigins.has(origin)) {
    return res.status(403).json({ error: 'Origen no autorizado' });
  }
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, bucket: bucketName || null, prefix });
});

app.get('/api/roms', async (req, res) => {
  if (!bucketName || !endpoint || !accessKeyId || !secretAccessKey) {
    return res.status(500).json({ error: 'Falta configuración de Backblaze B2' });
  }

  try {
    const [obj, covers, romMetadata] = await Promise.all([
      s3Client.send(new ListObjectsV2Command({
        Bucket: bucketName,
        ...(prefix ? { Prefix: `${prefix}/` } : {}),
      })),
      s3Client.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: coverPrefix() })),
      getRomMetadata(),
    ]);
    const coverKeys = new Set((covers.Contents || []).map(item => item.Key));

    const items = (obj.Contents || [])
      .filter(item => item.Key && isRomKey(item.Key))
      .map(async item => {
        const key = item.Key;
        const name = key.split('/').pop();
        const coverKey = coverKeyForRom(key);
        return {
          id: key,
          name,
          core: romMetadata[key] || coreFromKey(key),
          size: item.Size || 0,
          added: item.LastModified ? item.LastModified.getTime() : Date.now(),
          url: await signUrl(key),
          coverUrl: coverKeys.has(coverKey) ? await signUrl(coverKey) : null,
        };
      });

    res.json(await Promise.all(items));
  } catch (error) {
    console.error('Error listando ROMs en B2', error);
    res.status(500).json({ error: 'No se pudieron listar los ROMs de Backblaze B2' });
  }
});

app.get('/api/roms/play-counts', async (req, res) => {
  if (!bucketName || !endpoint || !accessKeyId || !secretAccessKey) {
    return res.status(500).json({ error: 'Falta configuración de Backblaze B2' });
  }

  try {
    res.json(await getRomPlayCounts());
  } catch (error) {
    console.error('Error leyendo partidas desde B2', error);
    res.status(500).json({ error: 'No se pudieron cargar las partidas desde Backblaze B2' });
  }
});

app.post('/api/roms/play', async (req, res) => {
  if (!bucketName || !endpoint || !accessKeyId || !secretAccessKey) {
    return res.status(500).json({ error: 'Falta configuración de Backblaze B2' });
  }

  const romKey = cleanKey(req.body?.id);
  if (!isRomKey(romKey)) {
    return res.status(400).json({ error: 'ROM no válido para registrar una partida' });
  }

  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: romKey }));
    const playCount = await incrementRomPlayCount(romKey);
    res.json({ id: romKey, playCount });
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'ROM no encontrado' });
    }
    console.error('Error registrando partida en B2', error);
    res.status(500).json({ error: 'No se pudo registrar la partida en Backblaze B2' });
  }
});

app.post('/api/roms/upload', upload.single('file'), async (req, res) => {
  if (!bucketName || !endpoint || !accessKeyId || !secretAccessKey) {
    return res.status(500).json({ error: 'Falta configuración de Backblaze B2' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Debe enviar un archivo' });
  }

  try {
    const nameFromBody = req.body.name || req.file.originalname || 'rom';
    const fileName = sanitizeFileName(nameFromBody);
    const selectedCore = String(req.body.core || '');
    const core = VALID_CORES.has(selectedCore) ? selectedCore : inferCore(fileName);
    if (!VALID_CORES.has(core)) {
      return res.status(400).json({ error: 'Selecciona el sistema de la ROM antes de subirla' });
    }

    const key = `${prefix ? `${prefix}/` : ''}${core}/${fileName}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'application/octet-stream',
    }));

    res.json({
      id: key,
      name: fileName,
      core,
      size: req.file.size,
      added: Date.now(),
      url: await signUrl(key),
    });
  } catch (error) {
    console.error('Error subiendo ROM a B2', error);
    res.status(500).json({ error: 'No se pudo guardar la ROM en Backblaze B2' });
  }
});

app.put('/api/roms/core', async (req, res) => {
  const romKey = cleanKey(req.body.id);
  const core = String(req.body.core || '');
  if (!isRomKey(romKey)) {
    return res.status(400).json({ error: 'ROM no válido para asignar un sistema' });
  }
  if (!VALID_CORES.has(core)) {
    return res.status(400).json({ error: 'Selecciona un sistema compatible' });
  }

  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: romKey }));
    const metadata = await getRomMetadata();
    const updatedMetadata = { ...metadata, [romKey]: core };
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: metadataKey(),
      Body: JSON.stringify(updatedMetadata),
      ContentType: 'application/json',
    }));
    romMetadataCache = updatedMetadata;
    res.json({ id: romKey, core });
  } catch (error) {
    console.error('Error guardando el sistema de la ROM', error);
    res.status(500).json({ error: 'No se pudo guardar el sistema en Backblaze B2' });
  }
});

app.put('/api/roms/cover', coverUpload.single('cover'), async (req, res) => {
  if (!bucketName || !endpoint || !accessKeyId || !secretAccessKey) {
    return res.status(500).json({ error: 'Falta configuración de Backblaze B2' });
  }

  const romKey = cleanKey(req.body.id);
  if (!isRomKey(romKey)) {
    return res.status(400).json({ error: 'ROM no válido para asignar una carátula' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Selecciona una imagen de carátula' });
  }
  if (!COVER_TYPES.has(req.file.mimetype)) {
    return res.status(415).json({ error: 'La imagen debe ser JPG, PNG, WebP o GIF' });
  }

  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: bucketName, Key: romKey }));
    const key = coverKeyForRom(romKey);
    await s3Client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    res.json({ coverUrl: await signUrl(key) });
  } catch (error) {
    console.error('Error guardando carátula en B2', error);
    res.status(500).json({ error: 'No se pudo guardar la carátula en Backblaze B2' });
  }
});

app.get('/api/roms/:key(*)', async (req, res) => {
  try {
    const key = cleanKey(req.params.key);
    const name = key.split('/').pop();
    const signedUrl = await signUrl(key);
    res.json({
      id: key,
      name,
      core: (await getRomMetadata())[key] || coreFromKey(key),
      size: 0,
      added: Date.now(),
      url: signedUrl,
    });
  } catch (error) {
    console.error('Error generando URL firmada', error);
    res.status(500).json({ error: 'No se pudo obtener la ROM desde B2' });
  }
});

app.listen(port, () => {
  console.log(`EmUApp escuchando en http://localhost:${port}`);
  console.log(`Backblaze B2 bucket: ${bucketName || 'sin configurar'}`);
});
