process.env.APP_MODE='mes';
process.env.HOST||='0.0.0.0';
process.env.FILES_ROOT||='/data/files';
process.env.DRIVE_TOKEN_FILE||='/data/drive-credentials.json';
process.env.MES_WEB_ROOT=new URL('./mes/dist/',import.meta.url).pathname;
if(!process.env.MES_ORIGIN||!process.env.DATABASE_URL)throw new Error('MES_ORIGIN and DATABASE_URL must be configured.');
await import('./dist/server/app.cjs');
