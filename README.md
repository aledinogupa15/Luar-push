# Luar push (servidor de avisos de Luar Mind)

Servidor pequeño que manda los recordatorios de Luar Mind aunque la app esté cerrada (Web Push).

Qué guarda: la suscripción de avisos del navegador, zona horaria, hora del aviso diario, "no molestar", hora de las tareas de hoy
(y su texto solo si la persona lo permite), si registró su ánimo hoy y su racha. **No recibe** diario, ánimos, pensamientos, chat ni perfil.

## Poner en línea en Render (plan gratuito)

1. Crea un repositorio nuevo en GitHub (por ejemplo `luar-push`) y sube estos archivos: `server.js`, `package.json`, `README.md`, `.gitignore`, `test.js`.
2. En Render: **New → Web Service**, elige ese repositorio.
   - Runtime: Node · Build command: `npm install` · Start command: `npm start` · Plan: Free.
3. Variables de entorno (Environment):
   - `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`: genéralas una sola vez con `npx web-push generate-vapid-keys` y no las cambies (si cambian, hay que volver a activar los avisos en cada dispositivo).
   - `ALLOWED_ORIGINS`: la dirección de tu web de Luar Mind, por ejemplo `https://luar-mind.onrender.com`.
   - `VAPID_SUBJECT` (opcional): una dirección `https://` o `mailto:` de contacto.
4. En la app: **Cuenta → Recordatorios y sonido → Avisos con la app cerrada**. Si el nombre del servicio no es `luar-push`, pega su dirección en "Avanzado".

## Mantenerlo despierto

El plan gratuito de Render duerme el servicio tras ~15 minutos sin visitas, y mientras duerme no manda avisos.
Opciones: un monitor gratuito (por ejemplo UptimeRobot o cron-job.org) que abra `https://TU-SERVICIO.onrender.com/health` cada 5 minutos, o el plan de pago "Starter".

## Pruebas

`npm install && npm test`
