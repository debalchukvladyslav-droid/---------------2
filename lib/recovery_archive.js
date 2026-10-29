import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const MAGIC = Buffer.from('TJARCH01');
export const archiveHash = bytes => createHash('sha256').update(bytes).digest('hex');
export function sealArchive(value, password) {
    if (String(password || '').length < 16) throw new Error('Archive password must contain at least 16 characters');
    const salt = randomBytes(16), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
    cipher.setAAD(MAGIC);
    const encrypted = Buffer.concat([cipher.update(gzipSync(JSON.stringify(value))), cipher.final()]);
    return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), encrypted]);
}
export function openArchive(bytes, password) {
    if (!bytes.subarray(0, 8).equals(MAGIC)) throw new Error('Unknown archive format');
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, bytes.subarray(8, 24), 32), bytes.subarray(24, 36));
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(bytes.subarray(36, 52));
    return JSON.parse(gunzipSync(Buffer.concat([decipher.update(bytes.subarray(52)), decipher.final()])).toString('utf8'));
}
export function restoreEntry(record) {
    if (record?.kind !== 'restore_point') throw new Error('Choose a restore-point record');
    return { ...record.metadata, version: 2, snapshot: JSON.parse(record.snapshotText), importedFile: true };
}
export const sqlString = value => "'" + String(value).replaceAll("'", "''") + "'";

// Payload dictionaries avoid sending hundreds of identical large settings across
// the network. Row metadata and exact PostgreSQL JSON text remain recoverable.
export function historyArchiveQuery(afterId, limit = 200, skipArchived = false) {
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid history page');
    return `with page as materialized (
        select * from data_recovery.change_history h where id>${afterId}
        ${skipArchived ? 'and not exists(select 1 from data_recovery.history_archives a where a.row_ids @> array[h.id])' : ''}
        order by id limit ${limit}
    ), payloads as materialized (
        select old_record::text as value from page where old_record is not null
        union all select new_record::text from page where new_record is not null
    ), dictionary as (
        select distinct on (encode(sha256(convert_to(value,'UTF8')),'hex'))
            encode(sha256(convert_to(value,'UTF8')),'hex') as hash,value from payloads
    ) select jsonb_build_object('kind','history','rows',coalesce((select jsonb_agg(jsonb_build_object(
        'metadata',to_jsonb(p)-'old_record'-'new_record',
        'oldHash',case when old_record is null then null else encode(sha256(convert_to(old_record::text,'UTF8')),'hex') end,
        'newHash',case when new_record is null then null else encode(sha256(convert_to(new_record::text,'UTF8')),'hex') end
    ) order by id) from page p),'[]'::jsonb),'payloads',coalesce((select jsonb_object_agg(hash,value) from dictionary),'{}'::jsonb)) as page`;
}
