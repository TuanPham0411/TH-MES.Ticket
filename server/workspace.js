import {driveApi} from './drive-client.js';
import {serveCloudMedia,removeCloudFile,prepareCloudOriginal,commitCloudRecord} from './cloud-media.js';
import {publishFile} from './publish.js';
import {filePath,deleteEverywhere,storageQuota} from "./storage.js";
import {displayPath} from "./media.js";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, rm, link } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { actorFor, hash, token } from "./security.js";
const fail = (status, message) =>
  Object.assign(new Error(message), { status, expose: true });
const videoTypes = new Set(["video/mp4", "video/webm", "video/quicktime"]);
export function workspaceRouter(pool, filesRoot) {
  const router = Router();
  async function pruneNotice(ids) {
    if (!ids?.length) return;
    const { rows } = await pool.query(
      "delete from public.mes_media m where m.id=any($1::text[]) and m.purpose='notice' and not exists(select 1 from public.mes_workspace w where w.kind='announcements' and coalesce(w.data->'media','[]'::jsonb) ? m.id) returning m.id",
      [ids],
    );
    for (const item of rows)
      {await removeCloudFile(pool,`media/${item.id}`);await deleteEverywhere(filesRoot, `media/${item.id}`);}
  }

  async function session(actor, owner = false) {
    if (!actor.session) {if(owner)throw fail(401,"Sign in first");return {isOwner:false,isViewer:true};}
    const {
      rows: [row],
    } = await pool.query("select public.mes_dispatch($1,$2,$3) result", [
      "getSession",
      {},
      actor,
    ]);
    if (owner && !row.result.isOwner) throw fail(403, "Administrator required");
    return row.result;
  }
  const actor = (req) =>
    actorFor(req.cookies.th_mes, req.headers["x-mes-tester"]);
  router.get("/media/:id", async (req, res) => {
    const current = await session(actor(req));
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return res.sendStatus(404);
    const {
      rows: [media],
    } = await pool.query(
      "select * from public.mes_media where id=$1 and ready",
      [req.params.id],
    );
    if (!media) return res.sendStatus(404);
    if (media.purpose === "notice" && !current.isOwner) {
      const { rowCount } = await pool.query(
        "select 1 from public.mes_workspace w where w.kind='announcements' and w.data->>'active'='true' and coalesce(w.data->'media','[]'::jsonb) ? $1",
        [media.id],
      );
      if (!rowCount) return res.sendStatus(404);
    }
    if(media.purpose==='page'&&!current.isOwner){const allowed=await pool.query("select 1 from public.mes_pages p where not deleted and active and (visibility='public' or ($2::boolean and visibility='members')) and exists(select 1 from jsonb_array_elements(p.widgets) w where coalesce(w->'media','[]'::jsonb) ? $1)",[media.id,!current.isViewer]);if(!allowed.rowCount)return res.sendStatus(404);}
    if(media.purpose==='notification'){
      if(current.isViewer)throw fail(401,'Sign in first');
      await pool.query('select public.mes_dispatch($1,$2,$3) result',['canReadNotificationMedia',{id:media.id},actor(req)]);
    }
    const documentFile=!media.type.startsWith('image/')&&!media.type.startsWith('video/');
    if(req.query.download==='1'||(documentFile&&!(media.type==='application/pdf'&&req.query.inline==='1')))res.attachment(media.title);
    if(documentFile)res.set('Content-Security-Policy',"frame-ancestors 'self'; base-uri 'none'; object-src 'none'");
    res.set({
      "Content-Type": media.type,
      "Cache-Control": "private, max-age=0, must-revalidate",
    });
    if(await serveCloudMedia(pool,filesRoot,`media/${media.id}`,req,res,media.type))return;
    res.set("X-Accel-Buffering","no");
    const display=await displayPath(filesRoot, `media/${media.id}`,req.query.preview==='1'&&media.type.startsWith('image/'));
    res.set('X-Media-Preview',display.endsWith('.preview.jpg')?'ready':'original');res.type(display.endsWith('.preview.jpg')?'image/jpeg':media.type);res.sendFile(display, { dotfiles: "deny" });
  });
  router.put("/media-upload/:grant", async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.grant)) return res.sendStatus(404);
    const {
      rows: [grant],
    } = await pool.query(
      "delete from public.file_grants where hash=$1 and action='workspaceVideo' and expires>now() returning *",
      [hash(req.params.grant)],
    );
    if (!grant) return res.sendStatus(403);
    await session(grant.actor, true);
    const {
      rows: [media],
    } = await pool.query(
      "select * from public.mes_media where id=$1 and not ready",
      [grant.path],
    );
    if (!media) return res.sendStatus(404);
    if (req.headers["content-type"] !== media.type)
      throw fail(400, "Invalid media type");
    const path = await filePath(filesRoot, `media/${media.id}`,true);
    await mkdir(join(path,".."), { recursive: true });
    const temporary = path + "." + token() + ".tmp";
    let size = 0;
    try {
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(
            size > Number(media.size)
              ? fail(413, "Video exceeds declared size")
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        req,
        limiter,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if (size !== Number(media.size)) throw fail(400, "Video incomplete");
      const cloud=await prepareCloudOriginal(pool,temporary,`media/${media.id}`,media.type,size);
      if(!cloud)await publishFile(temporary, path);
      const db=await pool.connect();
      try {await db.query('begin');if(cloud)await commitCloudRecord(db,cloud);
        await db.query("update public.mes_media set ready=true where id=$1", [media.id]);await db.query('commit');
      } catch (error) {
        await db.query('rollback');if(cloud)await driveApi(`files/${encodeURIComponent(cloud.drive_id)}`,{method:'DELETE'}).catch(()=>{});else await rm(path, {force:true});throw error;
      }finally{db.release();}
      res.json({ ok: true });
    } finally {
      await rm(temporary, { force: true });
    }
  });
  router.post("/workspace", async (req, res) => {
    const { action, data = {} } = req.body || {};
    if (
      typeof action !== "string" ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    )
      throw fail(400, "Invalid request");
    const current = await session(actor(req), action !== "read");
    if (action === "read") {
      const { rows } = await pool.query(
        "select kind,id,data from public.mes_workspace order by coalesce(data->>'updatedAt','0') desc,id",
      );
      const { rows: videos } = await pool.query(
        "select id,title,type,size,purpose from public.mes_media where ready order by created_at,id",
      );
      return res.json({
        announcements: rows
          .filter(
            (r) =>
              r.kind === "announcements" && (current.isOwner || r.data.active),
          )
          .map((r) => ({
            id: r.id,
            ...r.data,
            media: (r.data.media || [])
              .map((id) =>
                videos.find((v) => v.id === id && v.purpose === "notice"),
              )
              .filter(Boolean),
          })),
        issueTypes: rows
          .filter((r) => r.kind === "issueTypes")
          .map((r) => ({ id: r.id, ...r.data })),
        videos: videos.filter((v) => v.purpose === "playlist"),
      });
    }
    if (action === "save") {
      const { kind, id = randomUUID() } = data;
      if (
        !["announcements", "issueTypes"].includes(kind) ||
        typeof id !== "string" ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(id)
      )
        throw fail(400, "Invalid item");
      if (data.active !== undefined && typeof data.active !== "boolean")
        throw fail(400, "Invalid publication state");
      const value = { active: data.active !== false, updatedAt: Date.now() };
      if (kind === "announcements") {
        if (
          typeof data.title !== "string" ||
          !data.title.trim() ||
          data.title.length > 140 ||
          typeof data.body !== "string" ||
          !data.body.trim() ||
          data.body.length > 3000
        )
          throw fail(400, "Invalid announcement");
        const media = data.media || [];
        if (
          !Array.isArray(media) ||
          media.length > 5 ||
          media.some(
            (id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id),
          ) ||
          new Set(media).size !== media.length
        )
          throw fail(400, "Maximum five notice attachments");
        const { rowCount } = await pool.query(
          "select id from public.mes_media where id=any($1::text[]) and ready and purpose='notice'",
          [media],
        );
        if (rowCount !== media.length)
          throw fail(400, "Notice media unavailable");
        value.media = media;
        Object.assign(value, {
          title: data.title.trim(),
          body: data.body.trim(),
          pinned: data.pinned === true,
          author: current.user.displayName,
        });
      } else {
        if (
          typeof data.name !== "string" ||
          !data.name.trim() ||
          data.name.length > 80
        )
          throw fail(400, "Invalid name");
        value.name = data.name.trim();
      }
      const max = kind === "issueTypes" ? 50 : 30;
      const previous =
        kind === "announcements"
          ? (
              await pool.query(
                "select data from public.mes_workspace where kind='announcements' and id=$1",
                [id],
              )
            ).rows[0]?.data.media
          : [];
      const result = await pool.query(
        "insert into public.mes_workspace(kind,id,data) select $1,$2,$3 where exists(select 1 from public.mes_workspace where kind=$1 and id=$2) or (select count(*) from public.mes_workspace where kind=$1)<$4 on conflict(kind,id) do update set data=excluded.data returning id",
        [kind, id, value, max],
      );
      if (!result.rowCount) throw fail(400, "Workspace limit reached");
      await pruneNotice(previous);
      return res.json({ id });
    }
    if (action === "delete") {
      if (
        !["announcements", "issueTypes"].includes(data.kind) ||
        typeof data.id !== "string"
      )
        throw fail(400, "Invalid item");
      if (data.kind === "issueTypes" && data.id === "general")
        throw fail(400, "General is retained for older clients");
      const { rows: removed } = await pool.query(
        "delete from public.mes_workspace where kind=$1 and id=$2 returning data",
        [data.kind, data.id],
      );
      if (data.kind === "announcements")
        await pruneNotice(removed[0]?.data.media);
      return res.json({ ok: true });
    }
    if (action === "discardNoticeMedia") {
      if (
        !Array.isArray(data.ids) ||
        data.ids.length > 5 ||
        data.ids.some((id) => typeof id !== "string")
      )
        throw fail(400, "Invalid attachments");
      await pruneNotice(data.ids);
      return res.json({ ok: true });
    }
    if (action === "videoUpload" || action === "mediaUpload") {
      const purpose = data.purpose === "notice" ? "notice" : "playlist";
      const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
      if (
        !(
          videoTypes.has(data.type) ||
          (purpose === "notice" && imageTypes.has(data.type))
        ) ||
        typeof data.title !== "string" ||
        !data.title.trim() ||
        data.title.length > 140 ||
        !Number.isInteger(data.size) ||
        data.size < 1 ||
        data.size > (videoTypes.has(data.type) ? 200 : 10) * 1024 * 1024
      )
        throw fail(400, "Invalid video");
      await pool.query(
        "delete from public.mes_media where not ready and created_at<now()-interval '1 day' and not exists(select 1 from public.mes_uploads u where u.kind='media' and u.path=mes_media.id)",
      );
      const id = randomUUID();
      const created = await pool.query(
        "insert into public.mes_media(id,title,type,size,purpose) select $1,$2,$3,$4::bigint,$5 where (select count(*) from public.mes_media where purpose=$5)<(case when $5='playlist' then 20 else 150 end) and (select coalesce(sum(size),0) from public.mes_media)+(select coalesce(sum(size),0) from public.files)+(select coalesce(sum(size),0) from public.mes_uploads where kind='ticket' and not complete and expires>now())+$4::bigint<=$6::bigint returning id",
        [id, data.title.trim(), data.type, data.size, purpose, storageQuota()],
      );
      if (!created.rowCount)
        throw fail(400, "Video count or storage quota reached");
      const grant = token();
      await pool.query(
        "insert into public.file_grants(hash,action,path,actor,expires) values($1,'workspaceVideo',$2,$3,now()+interval '5 minutes')",
        [hash(grant), id, actor(req)],
      );
      return res.json({ id, url: `/api/mes/media-upload/${grant}` });
    }
    if (action === "videoUpdate") {
      if (
        typeof data.title !== "string" ||
        !data.title.trim() ||
        data.title.length > 140
      )
        throw fail(400, "Invalid title");
      await pool.query("update public.mes_media set title=$2 where id=$1", [
        data.id,
        data.title.trim(),
      ]);
      return res.json({ ok: true });
    }
    if (action === "videoDelete") {
      if((await pool.query("select 1 from public.mes_media where id=$1 and purpose in ('page','notification')",[data.id])).rowCount)throw fail(409,'Manage this file from its content tab.');
      const { rowCount } = await pool.query(
        "select 1 from public.mes_workspace where kind='announcements' and coalesce(data->'media','[]'::jsonb) ? $1",
        [data.id],
      );
      if (rowCount)
        throw fail(409, "Remove this media from its notice before deleting it");
      const {
        rows: [row],
      } = await pool.query(
        "delete from public.mes_media where id=$1 returning id",
        [data.id],
      );
      if (row) {await removeCloudFile(pool,`media/${row.id}`);await deleteEverywhere(filesRoot, `media/${row.id}`);}
      return res.json({ ok: true });
    }
    throw fail(400, "Unknown workspace action");
  });
  return router;
}
