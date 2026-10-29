import test from 'node:test';
import assert from 'node:assert/strict';
import { sealArchive,openArchive,archiveHash,restoreEntry,sqlString } from '../lib/recovery_archive.js';

test('encrypted archives survive a round trip and reject tampering or a wrong password', () => {
    const payload = { version: 1, records: [{ kind:'restore_point',metadata:{id:'point'},snapshotText:'{"tables":{"journal_days":[]}}' }] };
    const password = 'a-long-test-password-123';
    const encrypted = sealArchive(payload,password);
    assert.deepEqual(openArchive(encrypted,password),payload);
    assert.equal(restoreEntry(openArchive(encrypted,password).records[0]).version,2);
    assert.throws(()=>openArchive(encrypted,'a-different-password-123'));
    const corrupted = Buffer.from(encrypted); corrupted[corrupted.length-1]^=1;
    assert.notEqual(archiveHash(encrypted),archiveHash(corrupted));
    assert.throws(()=>openArchive(corrupted,password));
    assert.equal(sqlString("user's data"),"'user''s data'");
});
