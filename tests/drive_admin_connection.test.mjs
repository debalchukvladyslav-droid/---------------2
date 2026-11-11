import test from 'node:test';
import assert from 'node:assert/strict';
import { driveConnection } from '../api/drive-service.js';
import { runDriveSourceSync } from '../lib/source_worker.js';

test('admin sync persists a verified owner connection before registering Drive files', async () => {
    const events=[];
    const actual=await driveConnection({id:'admin'},'folder',{write:true},{
        resolve:async()=>({admin:true,user_id:'admin',resource_id:'folder'}),
        verifyFolder:async folder=>{events.push(['verify',folder]);},
        save:async args=>{events.push(['save',args]);return {id:'real-connection',...args};},
    });
    assert.equal(actual.id,'real-connection');
    assert.deepEqual(events,[['verify','folder'],['save',{userId:'admin',kind:'drive',resourceId:'folder'}]]);
});

test('an unreadable folder cannot create an admin connection or register screenshots', async () => {
    let saved=false;
    await assert.rejects(driveConnection({id:'admin'},'private',{write:true},{
        resolve:async()=>({admin:true}),verifyFolder:async()=>{throw Object.assign(new Error('forbidden'),{status:403});},
        save:async()=>{saved=true;},
    }),/forbidden/);
    assert.equal(saved,false);
});

test('an existing connection is reused; an explicit missing ID is never silently replaced', async () => {
    const existing={id:'real',user_id:'owner'};
    const deps={resolve:async()=>existing,save:async()=>{throw new Error('unexpected save');},verifyFolder:async()=>{throw new Error('unexpected verify');}};
    assert.equal(await driveConnection({id:'owner'},'folder',{write:true},deps),existing);
    await assert.rejects(driveConnection({id:'admin'},'folder',{write:true,connectionId:'missing'},
        {...deps,resolve:async()=>({admin:true})}),error=>error.code==='SOURCE_CONNECTION_REQUIRED');
});

test('a virtual folder never produces malformed RPC calls or downloads', async () => {
    let called=false;
    await assert.rejects(runDriveSourceSync({admin:true},{getToken:async()=>{called=true;}}),error=>error.code==='SOURCE_CONNECTION_REQUIRED');
    assert.equal(called,false);
});
