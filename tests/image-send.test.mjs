import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {BaseClient} from '@evex/linejs/base';
import {LineDriver} from '../server/drivers.mjs';
import {validateImageSend,IMAGE_SEND_MAX_BYTES} from '../server/image-send.mjs';
import {SendRejectedError} from '../server/errors.mjs';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub,localActor} from '../server/hub.mjs';
import {runCli} from '../client/cli.mjs';
import {createServer} from 'node:net';
import {createApps} from '../server/app.mjs';
import {Tunnels} from '../server/tunnels.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Synthetic images only; no real photos, accounts or network.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64');
const jpeg=Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x0b,0x08,0x00,0x02,0x00,0x03,0x01,0x01,0x11,0x00,0xff,0xd9]);
const b64=bytes=>Buffer.from(bytes).toString('base64');
const direct={id:'u'+'2'.repeat(32),kind:'direct'},openchat={id:'m'+'4'.repeat(32),kind:'openchat'};

test('image validation accepts bounded PNG/JPEG (including camera trailers) and rejects everything else',()=>{
  assert.equal(validateImageSend({data:b64(png)}).mimeType,'image/png');
  const trailer=validateImageSend({data:b64(Buffer.concat([jpeg,Buffer.from('SEFT synthetic vendor trailer')]))});
  assert.deepEqual([trailer.mimeType,trailer.width,trailer.height,trailer.filename],['image/jpeg',3,2,'image.jpg']);
  assert.equal(validateImageSend({data:b64(png),acknowledgeTransportSecurity:true}).acknowledgeTransportSecurity,true);
  for(const input of [null,[],{},{data:''},{data:'not base64!'},{data:b64(png)+'\n'},{data:b64(Buffer.from('GIF89a synthetic'))},{data:b64(png),filename:'x.png'},{data:b64(png),acknowledgeTransportSecurity:false}])
    assert.throws(()=>validateImageSend(input),e=>[400,415].includes(e.status));
  const huge=Buffer.alloc(IMAGE_SEND_MAX_BYTES+1);png.copy(huge);
  assert.throws(()=>validateImageSend({data:b64(huge)}),e=>[400,413].includes(e.status));
});

function pair(){const p=generateKeyPairSync('x25519');return {privKey:p.privateKey.export({format:'der',type:'pkcs8'}).subarray(-32).toString('base64'),pubKey:p.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64'),keyId:'123'};}
function fixture(){
  const self=pair(),receiver=pair(),values=new Map(),uploads=[],rpcs=[];
  const client=new BaseClient({device:'IOSIPAD',storage:{get:async key=>values.get(key),set:async(key,value)=>values.set(key,value)},fetch:async(info,init)=>{
    const req=new Request(info,init),target=new URL(req.url);assert.equal(target.origin,'https://obs.line-apps.com');
    uploads.push({path:target.pathname,params:JSON.parse(Buffer.from(req.headers.get('X-Obs-Params'),'base64').toString()),size:(await req.arrayBuffer()).byteLength});
    return new Response('',{headers:{'x-obs-oid':'synthetic-oid'}});
  }});
  client.authToken='synthetic-only';client.profile={mid:'u'+'1'.repeat(32)};values.set('e2eeKeys:'+client.profile.mid,JSON.stringify(self));
  client.talk.negotiateE2EEPublicKey=async()=>({specVersion:2,publicKey:{keyId:456,keyData:Buffer.from(receiver.pubKey,'base64')}});
  client.e2ee.getE2EELocalPublicKey=async()=>receiver;
  client.request.request=async(args,method)=>{rpcs.push(method);if(method==='sendMessage')return {id:'synthetic-message',createdTime:Date.now()};return {};};
  const driver=Object.create(LineDriver.prototype);driver.client=client;driver.requestSignal=new AsyncLocalStorage();
  return {client,driver,uploads,rpcs};
}

test('direct images upload encrypted with the pinned SDK and authorize at the send RPC boundary',async()=>{
  const f=fixture(),order=[],encrypt=f.client.e2ee.encryptE2EEMessage;
  const realRequest=f.client.request.request;f.client.request.request=async(...args)=>{order.push(args[1]);return realRequest(...args);};
  const result=await f.driver.sendImage(direct,{data:b64(png)},()=>order.push('authorize'));
  assert.deepEqual([result.messageId,result.protection,result.image.mimeType],['synthetic-message','letter_sealing','image/png']);
  assert.equal(f.uploads.length,2,'original and preview objects');assert.ok(f.uploads.every(u=>/^\/\/?r\/talk\/emi\//.test(u.path)&&u.params.type==='file'));
  assert.ok(f.uploads.every(u=>u.size>png.length),'only encrypted bytes reach OBS');
  assert.deepEqual(order.slice(-2),['authorize','sendMessage']);
  assert.equal(f.client.e2ee.encryptE2EEMessage,encrypt,'shared SDK methods are not mutated');
});

test('revoked authorization after upload sends no message; key enrollment is never attempted',async()=>{
  const f=fixture();
  await assert.rejects(f.driver.sendImage(direct,{data:b64(png)},()=>{throw new SendRejectedError(403,'send_authorization_revoked','synthetic');}),{code:'send_authorization_revoked'});
  assert.ok(!f.rpcs.includes('sendMessage'));
  const g=fixture();g.client.storage.set('e2eeKeys:'+g.client.profile.mid,undefined);
  g.client.e2ee.registerE2EEKeyPair=()=>assert.fail('image sends must never register keys');
  g.client.talk.getE2EEPublicKeys=async()=>[];
  await assert.rejects(g.driver.sendImage(direct,{data:b64(png)}),{code:'send_preparation_failed'});
  assert.ok(!g.rpcs.includes('sendMessage'));
});

test('OpenChat images require explicit transport acknowledgment and use reqseq-mode upload',async()=>{
  const f=fixture();let authorized=0;
  await assert.rejects(f.driver.sendImage(openchat,{data:b64(png)},()=>authorized++),{code:'image_transport_acknowledgment_required'});
  assert.equal(f.uploads.length,0);assert.equal(authorized,0);
  const result=await f.driver.sendImage(openchat,{data:b64(png),acknowledgeTransportSecurity:true},()=>authorized++);
  assert.deepEqual([result.messageId,result.objectId,result.protection],[null,'synthetic-oid','line_transport']);
  assert.equal(authorized,1);assert.equal(f.uploads.length,1);assert.match(f.uploads[0].path,/^\/\/?r\/g2\/m\/reqseq$/);
  assert.equal(f.uploads[0].params.tomid,openchat.id);assert.equal(f.uploads[0].params.name,'image.png');
});

test('hub image sends require scope and idempotency, replay by content hash and never resend unknown outcomes',async t=>{
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault);t.after(()=>{hub.close();store.close();});
  const account=await hub.addAccount({label:'Synthetic',kind:'demo'});hub.designate(account.id,'demo-group',true);hub.designate(account.id,'demo-openchat',true);
  await assert.rejects(hub.sendImage(localActor,account.id,'demo-group',{data:b64(png)},'short'),{code:'idempotency_required'});
  const first=await hub.sendImage(localActor,account.id,'demo-group',{data:b64(png)},'image-key-001');
  assert.equal(first.delivery,'sandbox_only');assert.equal(first.replayed,false);
  assert.equal((await hub.sendImage(localActor,account.id,'demo-group',{data:b64(png)},'image-key-001')).replayed,true);
  await assert.rejects(hub.sendImage(localActor,account.id,'demo-group',{data:b64(jpeg)},'image-key-001'),{code:'idempotency_conflict'});
  await assert.rejects(hub.sendImage(localActor,account.id,'demo-openchat',{data:b64(png)},'image-key-002'),{code:'image_transport_acknowledgment_required'});
  assert.equal((await hub.sendImage(localActor,account.id,'demo-openchat',{data:b64(png),acknowledgeTransportSecurity:true},'image-key-003')).replayed,false);
  const driver=hub.driver(account.id);driver.sendImage=async()=>{throw new Error('synthetic transport failure');};
  await assert.rejects(hub.sendImage(localActor,account.id,'demo-group',{data:b64(jpeg)},'image-key-004'),{code:'delivery_unknown'});
  await assert.rejects(hub.sendImage(localActor,account.id,'demo-group',{data:b64(jpeg)},'image-key-004'),{code:'delivery_unknown'});
});

test('CLI send-image validates locally and posts base64 with the idempotency key',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'linebridge-image-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'synthetic.png'),bad=join(dir,'synthetic.txt');await writeFile(file,png);await writeFile(bad,'not an image');
  const run=async(args,fetchImpl=async()=>assert.fail('no request expected'))=>{let stdout='';const code=await runCli(args,{env:{LINE_BRIDGE_TOKEN:'synthetic'},stdin:Readable.from([]),stdout:{write:v=>stdout+=v},stderr:{write(){}},fetchImpl});return {code,...JSON.parse(stdout)};};
  assert.equal((await run(['send-image','--account','a','--chat','c','--key','image-key-001','--file',bad])).error,'invalid_input');
  let request;
  const ok=await run(['send-image','--account','a','--chat','c','--key','image-key-001','--file',file,'--acknowledge-transport-security'],async(url,init)=>{request={url,init};return new Response(JSON.stringify({messageId:null,objectId:'synthetic-oid',delivery:'accepted_by_line'}));});
  assert.equal(ok.code,0);assert.equal(ok.objectId,'synthetic-oid');
  assert.match(request.url,/\/api\/v1\/accounts\/a\/chats\/c\/images$/);assert.equal(request.init.headers['Idempotency-Key'],'image-key-001');
  assert.deepEqual(JSON.parse(request.init.body),{data:b64(png),acknowledgeTransportSecurity:true});
});

test('HTTP and MCP image routes accept multi-MB bodies while other routes keep the 32 KB limit',async t=>{
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault);t.after(()=>{hub.close();store.close();});
  const account=await hub.addAccount({label:'Synthetic',kind:'demo'});hub.designate(account.id,'demo-group',true);
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const tunnels=new Tunnels(store,hub.vault,process.cwd(),port);t.after(()=>tunnels.close());
  const {gateway}=createApps({hub,tunnels,root:process.cwd(),adminPort:0,gatewayPort:port});const server=gateway.listen(port,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${port}`,token=hub.createToken({name:'Synthetic',grants:[{accountId:account.id,read:true,send:true}]}),headers={Authorization:`Bearer ${token.token}`,'content-type':'application/json'};
  // A synthetic 3 MB JPEG: valid header and dimensions, random filler, vendor trailer.
  const big=Buffer.concat([jpeg.subarray(0,-2),randomBytes(3*1024*1024),Buffer.from([0xff,0xd9])]);
  const url=`${base}/api/v1/accounts/${account.id}/chats/demo-group/images`;
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({data:b64(big)})})).status,400,'idempotency key is still required');
  const sent=await fetch(url,{method:'POST',headers:{...headers,'Idempotency-Key':'http-image-001'},body:JSON.stringify({data:b64(big)})});
  assert.equal(sent.status,200);assert.equal((await sent.json()).image.bytes,big.length);
  assert.equal((await fetch(`${base}/api/v1/messages/search`,{method:'POST',headers,body:JSON.stringify({query:'a'.repeat(40000)})})).status,413);
  const client=new Client({name:'image-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{Authorization:headers.Authorization}}}));t.after(()=>client.close());
  const mcp=await client.callTool({name:'line_send_image',arguments:{accountId:account.id,chatId:'demo-group',data:b64(big),idempotencyKey:'mcp-image-001'}});
  assert.equal(mcp.isError,undefined);assert.equal(JSON.parse(mcp.content[0].text).delivery,'sandbox_only');
});
