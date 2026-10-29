import {PAGE_FILE_TYPES} from './page-types.js';
import {prepareCloudOriginal,commitCloudRecord,mediaProvider} from './cloud-media.js';
import {driveApi} from './drive-client.js';
import {publishFile} from './publish.js';
import {filePath,deleteEverywhere,storageQuota} from "./storage.js";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, rm, link, truncate } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { join } from "node:path";
import { actorFor, validPath } from "./security.js";
export const VIDEO_LIMIT = 200 * 1024 * 1024,
  CHUNK_LIMIT = 4 * 1024 * 1024;
const types = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const fail = (status, message) =>
  Object.assign(new Error(message), { status, expose: true });
export function uploadRouter(pool, root, gate) {
  const router = Router();
  const actor = (req) =>
    actorFor(req.cookies.th_ticket, req.headers["x-ticket-tester"]);
  async function dispatch(db, name, data, identity) {
    const {
      rows: [r],
    } = await db.query("select public.ticket_dispatch($1,$2,$3) result", [
      name,
      data,
      identity,
    ]);
    return r.result;
  }
  async function authorize(db, req, record) {
    const identity = actor(req);
    if (!identity.session) throw fail(401, "Sign in first");
    const session = await dispatch(db, "getSession", {}, identity);
    if (record?.owner_uid && record.owner_uid !== session.user.uid)
      throw fail(403, "Not your upload");
    if (record?.kind === "ticket")
      await dispatch(db, "uploadUrl", { path: record.path }, identity);
    if (record?.kind === "media") {
      const media=(await db.query('select purpose from public.ticket_media where id=$1',[record.path])).rows[0];
      if(media?.purpose==='notification')await dispatch(db,'authorizeNotificationMedia',{id:record.path},identity);
      else if (!session.isOwner) throw fail(403, "Administrator required");
      const { rowCount } = await db.query(
        "select 1 from public.ticket_media where id=$1",
        [record.path],
      );
      if (!rowCount) throw fail(404, "Media unavailable");
    }
    return session;
  }
  router.post("/", async (req, res) => {
    const { kind, path, type, size } = req.body || {};
    if (
      !["ticket", "media"].includes(kind) ||
      typeof path !== "string" ||
      (kind === "ticket" ? !validPath(path) : !/^[a-f0-9-]{36}$/.test(path)) ||
      (!types.has(type)&&!(kind==='media'&&PAGE_FILE_TYPES.has(type))) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > (type.startsWith("video/") ? VIDEO_LIMIT : 10485760)
    )
      throw fail(
        400,
        "Invalid upload. Videos: maximum 200 MB; other files: 10 MB.",
      );
    const record = { kind, path, type, size };
    const session = await authorize(pool, req, record);
    record.owner_uid = session.user.uid;
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("select pg_advisory_xact_lock(74529082)");
      const {
        rows: [previous],
      } = await db.query(
        "select * from public.ticket_uploads where kind=$1 and path=$2 for update",
        [kind, path],
      );
      if (previous) {
        if (previous.owner_uid !== record.owner_uid)
          throw fail(403, "Not your upload");
        if (Number(previous.size) !== size || previous.type !== type)
          throw fail(409, "Upload does not match the existing file");
        if (new Date(previous.expires) < new Date())
          throw fail(410, "Upload expired. Please use a new file slot.");
        await db.query("commit");
        cloudErrors.delete(previous.id);
        return res.json({
          id: previous.id,
          offset: Number(previous.offset_bytes),
          complete: previous.complete,
          chunkSize: CHUNK_LIMIT,
        });
      }
      if (kind === "media") {
        const {
          rows: [media],
        } = await db.query(
          "select * from public.ticket_media where id=$1 and not ready for update",
          [path],
        );
        if (!media || Number(media.size) !== size || media.type !== type)
          throw fail(400, "Media reservation differs");
      } else {
        const {
          rows: [quota],
        } = await db.query(
          "select (select coalesce(sum(size),0) from public.files)+(select coalesce(sum(size),0) from public.ticket_media)+(select coalesce(sum(size),0) from public.ticket_uploads where kind='ticket' and not complete and expires>now()) used",
        );
        if (Number(quota.used) + size > storageQuota())
          throw fail(507, "Storage quota reached");
      }
      const id = randomUUID();
      await db.query(
        "insert into public.ticket_uploads(id,kind,path,owner_uid,type,size) values($1,$2,$3,$4,$5,$6)",
        [id, kind, path, record.owner_uid, type, size],
      );
      await db.query("commit");
      res.json({ id, offset: 0, complete: false, chunkSize: CHUNK_LIMIT });
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
    }
  });
  const active = new Set();
  const cloudErrors = new Map();
  async function finalizeCloud(record, req) {
    if(active.has(record.id)) return;
    active.add(record.id); cloudErrors.delete(record.id);
    let cloud, db;
    try {
      const temporary=await filePath(root,`.uploads/${record.id}.part`);
      cloud=await prepareCloudOriginal(pool,temporary,record.kind==='ticket'?record.path:'media/'+record.path,record.type,record.size);
      if(!cloud)throw fail(409,'Storage changed. Retry the upload after selecting Drive.');
      db=await pool.connect(); await db.query('begin');
      const locked=(await db.query('select * from public.ticket_uploads where id=$1 for update',[record.id])).rows[0];
      if(!locked||locked.complete||Number(locked.offset_bytes)!==Number(record.size))throw fail(409,'Upload state changed');
      await authorize(db,req,record); await commitCloudRecord(db,cloud);
      if(record.kind==='ticket')await db.query('insert into public.files(path,type,size) values($1,$2,$3)',[record.path,record.type,record.size]);
      else await db.query('update public.ticket_media set ready=true where id=$1',[record.path]);
      await db.query('update public.ticket_uploads set complete=true where id=$1',[record.id]);
      await db.query('commit'); cloud=null;
      await rm(temporary,{force:true}).catch(()=>{});
    }catch(error){
      if(db)await db.query('rollback').catch(()=>{});
      if(cloud)await driveApi(`files/${encodeURIComponent(cloud.drive_id)}`,{method:'DELETE'}).catch(()=>{});
      if(cloudErrors.size>500)cloudErrors.clear();
      cloudErrors.set(record.id,'Drive transfer failed. Your temporary file was kept. Retry the upload.');
    }finally{db?.release();active.delete(record.id);}
  }
  router.all("/:id", async (req, res) => {
    if (!["GET", "PATCH"].includes(req.method)) return res.sendStatus(405);
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.sendStatus(404);
    const {
      rows: [initial],
    } = await pool.query(
      "select * from public.ticket_uploads where id=$1 and expires>now()",
      [req.params.id],
    );
    if (!initial) throw fail(410, "Upload expired or unavailable");
    await authorize(pool, req, initial);
    if (req.method === "GET") {
      if(cloudErrors.has(initial.id))return res.status(502).json({error:cloudErrors.get(initial.id)});
      if(!initial.complete&&Number(initial.offset_bytes)===Number(initial.size))void gate.background(()=>finalizeCloud(initial,req));
      return res.json({
        offset: Number(initial.offset_bytes),
        size: Number(initial.size),
        complete: initial.complete,
        processing: active.has(initial.id),
      });
    }
    if (active.has(initial.id))
      return res
        .status(409)
        .json({
          error: "Chunk already in progress",
          offset: Number(initial.offset_bytes),
        });
    active.add(initial.id);
    let temporary,
      originalOffset,
      linked,
      wrote = false,
      db,cloud;
    try {
      const {
        rows: [record],
      } = await pool.query("select * from public.ticket_uploads where id=$1", [
        initial.id,
      ]);
      const current = Number(record.offset_bytes);
      originalOffset = current;
      if (record.complete) return res.json({ offset: current, complete: true });
      if (
        !/^\d+$/.test(req.headers["upload-offset"] || "") ||
        Number(req.headers["upload-offset"]) !== current
      )
        return res
          .status(409)
          .json({ error: "Upload offset differs", offset: current });
      if (req.headers["content-type"] !== "application/octet-stream")
        throw fail(400, "Use binary chunks");
      temporary = await filePath(root, `.uploads/${record.id}.part`, true);
      await mkdir(join(temporary,".."), { recursive: true });
      let received = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          callback(
            received > CHUNK_LIMIT || current + received > Number(record.size)
              ? fail(413, "Chunk exceeds upload limits")
              : null,
            chunk,
          );
        },
      });
      wrote = true;
      await pipeline(
        req,
        limiter,
        createWriteStream(temporary, {
          flags: current ? "r+" : "w",
          start: current,
          mode: 0o600,
        }),
      );
      if (!received) throw fail(400, "Empty chunk");
      const next = current + received,
        complete = next === Number(record.size);
      if(complete&&await mediaProvider(pool)==='drive'){
        await pool.query("update public.ticket_uploads set offset_bytes=$2,expires=now()+interval '2 hours' where id=$1",[record.id,next]);
        wrote=false; active.delete(record.id);
        void gate.background(()=>finalizeCloud({...record,offset_bytes:next},req));
        return res.status(202).json({offset:next,complete:false,processing:true});
      }
      // Never hold a database connection while the client streams a chunk.
      db = await pool.connect();
      await db.query("begin");
      const {
        rows: [locked],
      } = await db.query(
        "select * from public.ticket_uploads where id=$1 for update",
        [record.id],
      );
      if (!locked || Number(locked.offset_bytes) !== current)
        throw fail(409, "Upload state changed");
      await authorize(db, req, record);
      if (complete) {
        const destination =
          record.kind === "ticket"
            ? join(temporary,"../..", record.path)
            : join(temporary,"../..", "media", record.path);
        if(cloud)await commitCloudRecord(db,cloud);
        else{await mkdir(join(destination, ".."), { recursive: true });await publishFile(temporary, destination);linked = destination;}
        if (record.kind === "ticket")
          await db.query(
            "insert into public.files(path,type,size) values($1,$2,$3)",
            [record.path, record.type, record.size],
          );
        else
          await db.query("update public.ticket_media set ready=true where id=$1", [
            record.path,
          ]);
      }
      await db.query(
        "update public.ticket_uploads set offset_bytes=$2,complete=$3,expires=now()+interval '2 hours' where id=$1",
        [record.id, next, complete],
      );
      await db.query("commit");
      linked = undefined;
      wrote = false;
      if (complete) await rm(temporary, { force: true }).catch(() => {});
      res.json({ offset: next, complete });
    } catch (error) {
      if (db) await db.query("rollback");
      if (linked) await rm(linked, { force: true });
      if(cloud)await driveApi(`files/${encodeURIComponent(cloud.drive_id)}`,{method:"DELETE"}).catch(()=>{});
      if (wrote && temporary)
        await truncate(temporary, originalOffset).catch(() => {});
      throw error;
    } finally {
      db?.release();
      if(wrote || db || !temporary)active.delete(initial.id);
    }
  });
  return router;
}
export async function cleanupUploads(pool, root) {
  const { rows } = await pool.query(
    "select id from public.ticket_uploads where expires<now() limit 100",
  );
  for (const row of rows) {
    await deleteEverywhere(root, `.uploads/${row.id}.part`);
    await pool.query("delete from public.ticket_uploads where id=$1 and expires<now()",[row.id]);
  }
  await pool.query(
    "delete from public.ticket_media where not ready and created_at<now()-interval '1 day' and not exists(select 1 from public.ticket_uploads u where u.kind='media' and u.path=ticket_media.id)",
  );
}
