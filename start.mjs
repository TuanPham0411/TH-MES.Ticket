process.env.APP_MODE='ticket';
process.env.HOST||='0.0.0.0';
process.env.FILES_ROOT||='/data/files';
process.env.DRIVE_TOKEN_FILE||='/data/drive-credentials.json';
process.env.TICKET_WEB_ROOT=new URL('./ticket/dist/',import.meta.url).pathname;
if(!process.env.TICKET_ORIGIN||!process.env.DATABASE_URL)throw new Error('TICKET_ORIGIN and DATABASE_URL must be configured.');
await import('./dist/server/app.cjs');
