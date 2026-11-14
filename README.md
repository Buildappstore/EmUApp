# EmUApp

Aplicación web para listar y lanzar ROMs con emulación en navegador.

## Backblaze B2

Este proyecto incluye un backend mínimo para usar Backblaze B2 como almacenamiento de archivos.

1. Copia `.env.example` a `.env`.
2. Completa tus credenciales de Backblaze B2.
3. Instala dependencias:
   `npm install`
4. Inicia la app:
   `npm start`
5. La app quedará disponible en http://localhost:3000 y usará B2 para listar y subir ROMs.

Al subir archivos ZIP, selecciona primero el sistema correspondiente. Los ZIP que ya estaban en el bucket se pueden clasificar desde su tarjeta con el selector de sistema y el botón «Guardar sistema».

Configuración necesaria en Backblaze B2:
- Crear un bucket.
- Generar una aplicación clave con acceso de lectura/escritura al bucket.
- Usar el endpoint S3 del bucket, por ejemplo `https://s3.us-west-004.backblazeb2.com`.
- `B2_PREFIX=roms` guarda y lista ROMs bajo esa carpeta. Déjala vacía (`B2_PREFIX=`) para listar objetos desde la raíz del bucket.

El backend queda compatible con el navegador: si B2 no está configurado, la app usa IndexedDB local como fallback.

## Publicación en GitHub Pages y Render

GitHub Pages publica la interfaz estática; Render ejecuta el backend que accede a B2.

1. En Render, crea un Blueprint desde este repositorio y completa `B2_BUCKET_NAME`, `B2_ENDPOINT`, `B2_KEY_ID` y `B2_APPLICATION_KEY` con los valores privados de B2. No subas esas claves al repositorio.
2. Espera a que el servicio `emuapp-b2-api` esté activo y verifica `https://<servicio>.onrender.com/api/health`.
3. En **Settings → Pages**, selecciona **GitHub Actions** como fuente. El workflow usa `https://emuapp-b2-api.onrender.com` por defecto. Si publicas tu propia instancia de la API, crea la variable `API_BASE_URL` en **Settings → Secrets and variables → Actions → Variables** con la URL de tu servicio, sin `/` al final.
4. Ejecuta el workflow **Deploy GitHub Pages** desde la pestaña **Actions** para publicar o actualizar la interfaz.
5. La página estará en `https://buildappstore.github.io/EmUApp/`.

El endpoint de subida queda público para que cualquiera pueda aportar juegos, como se solicita. Esto también permite que otras personas consuman almacenamiento y ancho de banda de B2. Para jugar desde GitHub Pages, configura CORS en el bucket de B2 para permitir lecturas `GET` y `HEAD` desde `https://buildappstore.github.io`.

## Carátulas

Cada juego permite subir o cambiar una carátula JPG, PNG, WebP o GIF de hasta 8 MB. Las imágenes se guardan en la ruta privada `covers/` de B2, asociadas al identificador del ROM, y no aparecen en la lista de juegos.

La búsqueda automática con ScreenScraper queda pendiente de credenciales de desarrollador y autorización de uso de su API.

La app no ofrece una acción para eliminar juegos del bucket.

La biblioteca agrupa los juegos por sistema. EmulatorJS dispone del core `3ds` (Azahar); los archivos `.3ds`, `.cci` y `.cxi` se asignan a ese core. Para archivos comprimidos, selecciona manualmente el sistema correcto.
