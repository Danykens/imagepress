// Browser-independent checks of preset and download/recompression event handlers.
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const downloads = [], requests = [];
function element() {
  return {value:'',checked:false,dataset:{},listeners:{},children:[],
    addEventListener(name, fn){this.listeners[name]=fn;},
    setAttribute(name,value){this[name]=value;}, append(...nodes){this.children.push(...nodes);},
    replaceChildren(...nodes){this.children=nodes;}, remove(){},
    click(){if(this.href) downloads.push(this.href);}, showModal(){},close(){}};
}
const nodes = new Map();
const get = id => {if(!nodes.has(id)) nodes.set(id,element()); return nodes.get(id);};
const buttons = ['light','medium','strong','balance'].map(name => Object.assign(element(),{dataset:{preset:name}}));
for(const [id,value] of Object.entries({format:'webp',quality:'80',size:'0',rotation:'0',flip:'none',background:'#ffffff'})) get(id).value=value;
get('keep').checked=true;
const context = vm.createContext({console,URLSearchParams,
  URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},
  document:{getElementById:get,querySelectorAll:()=>buttons,createElement:element,body:element()},
  window:{addEventListener(){}},setTimeout:fn=>fn(),
  fetch:async(url,options)=>{requests.push({url,options}); return {ok:true,json:async()=>url==='/api/config'?{token:'test'}:{id:'result'+requests.length,name:'photo.webp',size:50},blob:async()=>({})};}
});
vm.runInContext(readFileSync('static/app.js','utf8'),context);
(async()=>{
  buttons[2].listeners.click(); assert.equal(get('quality').value,45); assert.equal(get('size').value,1920);
  buttons[3].listeners.click(); assert.equal(get('quality').value,80); assert.equal(get('size').value,0);
  get('format').value='png'; buttons[0].listeners.click(); assert.equal(get('format').value,'webp');
  vm.runInContext("add([{name:'photo.png',size:100}])",context);
  await get('start').onclick(); assert.equal(get('start').disabled,false);
  assert.equal(get('download-files').disabled,false);
  await get('download-files').onclick(); assert.equal(downloads.length,1); assert.match(downloads[0],/^\/api\/file\//);
  buttons[2].listeners.click(); await get('start').onclick();
  const compress = requests.filter(r=>r.url.startsWith('/api/compress'));
  assert.equal(compress.length,2); assert.match(compress[1].url,/quality=45/);
  assert.equal(compress[0].options.body,compress[1].options.body);
  vm.runInContext("add([{name:'second.png',size:100}])",context);
  await get('start').onclick(); await get('download-files').onclick();
  assert.equal(downloads.length,3);
  console.log('PASS: presets, repeated compression from originals, single and multiple non-ZIP downloads');
})().catch(error=>{console.error(error);process.exitCode=1;});
