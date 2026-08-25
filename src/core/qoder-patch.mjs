import fs from "node:fs";
import path from "node:path";

const APP_ROOT_CANDIDATES = [
  "/Applications/Qoder CN IDE.app/Contents/Resources/app",
  "/Applications/Qoder CN.app/Contents/Resources/app",
  path.join(process.env.HOME || "", "Applications/Qoder CN IDE.app/Contents/Resources/app"),
  path.join(process.env.HOME || "", "Applications/Qoder CN.app/Contents/Resources/app")
];

const LOCAL_PROVIDER_KEY = "qoder-local-gateway";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8787";
const PATCH_MARKER = "QODER_BRIDGE_GATEWAY_PATCH_20260824";
const PATCH_MARKER_V2 = "QODER_BRIDGE_GATEWAY_PATCH_20260824_V2";
const PATCH_MARKER_V3 = "QODER_BRIDGE_GATEWAY_PATCH_20260824_V3";
const PATCH_MARKER_V4 = "QODER_BRIDGE_GATEWAY_PATCH_20260824_V4";
const PATCH_MARKER_V5 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V5";
const PATCH_MARKER_V6 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V6";
const PATCH_MARKER_V7 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V7";
const PATCH_MARKER_V8 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V8";
const PATCH_MARKER_V9 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V9";
const PATCH_MARKER_V10 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V10";
const PATCH_MARKER_V11 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V11";
const PATCH_MARKER_V12 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V12";

const LOCAL_PROVIDER_FIELDS = [
  {
    key: "api_key",
    display_name: { cn_zh: "本地占位凭据", en_us: "Local placeholder" }
  },
  {
    key: "base_url",
    display_name: { cn_zh: "Gateway Base URL", en_us: "Gateway Base URL" }
  }
];

function modelCapabilities(model) {
  return model.capabilities && typeof model.capabilities === "object"
    ? model.capabilities
    : {};
}

function providerForModels(models) {
  return {
    key: LOCAL_PROVIDER_KEY,
    source: "custom",
    enabled: true,
    display_name: {
      cn_zh: "Qoder Bridge Gateway",
      en_us: "Qoder Bridge Gateway"
    },
    fields: LOCAL_PROVIDER_FIELDS,
    types: [{
      key: "openai",
      display_name: {
        cn_zh: "OpenAI 兼容 Responses",
        en_us: "OpenAI-compatible Responses"
      },
      models: models.map((model) => {
        const capabilities = modelCapabilities(model);
        return {
          key: model.id,
          display_name: model.id,
          description: "通过本地 Qoder Bridge Gateway 连接",
          enabled: true,
          is_vl: capabilities.vision === true,
          is_reasoning: capabilities.reasoning === true,
          max_input_tokens: 180000
        };
      })
    }]
  };
}

export function modelRecordsForQoder(models, gatewayUrl) {
  const baseUrl = `${String(gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, "")}/v1`;
  return models.map((model) => {
    const capabilities = modelCapabilities(model);
    const modelId = String(model.id);
    const safeId = modelId.replace(/[^A-Za-z0-9_.-]/g, "_");
    return {
      id: `qoder-bridge-${safeId}`,
      provider: LOCAL_PROVIDER_KEY,
      providerDisplayName: "Qoder Bridge Gateway",
      model: modelId,
      displayName: modelId,
      description: "通过本地 Qoder Bridge Gateway 连接",
      baseUrl,
      visible: true,
      enabled: true,
      // Qoder uses this flag to enable a saved custom model. The gateway
      // itself does not need a Qoder-side credential for localhost calls.
      hasApiKey: true,
      is_vl: capabilities.vision === true,
      is_reasoning: capabilities.reasoning === true,
      max_input_tokens: 180000,
      byokTypeKey: "openai",
      qoderBridgeManaged: true,
      createTime: 0
    };
  });
}

function findQoderAppRoot(override) {
  if (override) return override;
  return APP_ROOT_CANDIDATES.find((candidate) =>
    fs.existsSync(path.join(candidate, "out/main.js"))
    && fs.existsSync(path.join(candidate, "extensions/aicoding-agent/dist/extension.js"))
  );
}

async function discoverModels(gatewayUrl, authorization) {
  const response = await fetch(`${gatewayUrl}/v1/models`, {
    headers: {
      accept: "application/json",
      ...(authorization
        ? { authorization: /^Bearer\s/i.test(authorization)
          ? authorization
          : `Bearer ${authorization}` }
        : {})
    }
  });
  if (!response.ok) {
    throw new Error(`Gateway /v1/models returned ${response.status}`);
  }
  const payload = await response.json();
  const models = Array.isArray(payload.data)
    ? payload.data.filter((model) => typeof model?.id === "string" && model.id)
    : [];
  if (models.length === 0) {
    throw new Error("Gateway /v1/models returned no usable models");
  }
  return models;
}

function backupFile(filePath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const destination = path.join(backupDir, path.basename(filePath));
  if (!fs.existsSync(destination)) {
    fs.copyFileSync(filePath, destination);
  }
  return destination;
}

function patchMainBundle(filePath, provider, managedModels) {
  let source = fs.readFileSync(filePath, "utf8");
  const original = source;
  const providerJson = JSON.stringify(provider);
  const managedModelsJson = JSON.stringify(managedModels);

  if (!source.includes(PATCH_MARKER)) {
    const normalizeNeedle =
      "return{enabled:e.enabled??!0,providers:e.providers}}async _waitForByokRequestReady";
    const normalizeReplacement =
      `return{enabled:e.enabled??!0,providers:[...e.providers.filter(t=>t.key!=="${LOCAL_PROVIDER_KEY}"),${providerJson}]}}async _waitForByokRequestReady`;
    source = source.split(normalizeNeedle).join(normalizeReplacement);

    source = source.split(
      "async checkByokConfig(e,n){const r=this._getByokCapabilityKey(n);"
    ).join(
      `async checkByokConfig(e,n){if(e?.provider==="${LOCAL_PROVIDER_KEY}")return{success:!0};const r=this._getByokCapabilityKey(n);`
    );

    source += `\n/* ${PATCH_MARKER} */\n`;
  }

  source = source.replace(
    /description:ge\.description,apiKey:Ee(?!,baseUrl:)/g,
    "description:ge.description,apiKey:Ee,baseUrl:he.base_url||he.baseUrl"
  );
  source = source.replace(
    /description:de\.description,apiKey:Se(?!,baseUrl:)/g,
    "description:de.description,apiKey:Se,baseUrl:ge.base_url||ge.baseUrl"
  );
  source = source.replace(
    /parameters:\{\.\.\.c\?\{api_key:c\}:\{\}\}/g,
    "parameters:{...l.baseUrl?{base_url:l.baseUrl}:{},...c?{api_key:c}:{}}"
  );
  source = source.replace(
    /parameters:\{\.\.\.l\?\{api_key:l\}:\{\}\}/g,
    "parameters:{...a.baseUrl?{base_url:a.baseUrl}:{},...l?{api_key:l}:{}}"
  );

  if (!source.includes(`${PATCH_MARKER_V5}: announcements disabled`)) {
    source = source.replace(
      /async function ([A-Za-z_$][\w$]*)\(t\)\{const e=t\.dynamicConfigService\.getConfig\(\)\?\.\["announcement-dialog"\];/g,
      `async function $1(t){return[];/* ${PATCH_MARKER_V5}: announcements disabled */const e=t.dynamicConfigService.getConfig()?.["announcement-dialog"];`
    );
  }

  if (!source.includes(`${PATCH_MARKER_V6}: integrity warning disabled`)) {
    source = source.replace(
      /_showNotification\(\)\{const e=this\.productService\.checksumFailMoreInfoUrl.*?priority:[A-Za-z_$][\w$]*\.URGENT\}\)\}/s,
      `_showNotification(){return;/* ${PATCH_MARKER_V6}: integrity warning disabled */}`
    );
  }

  source = replaceInjectedProvider(source, providerJson);
  source = replaceInjectedModels(source, managedModelsJson);

  const checks = [
    ["provider injection", source.includes(`key":"${LOCAL_PROVIDER_KEY}"`)],
    ["validation bypass", source.includes(`e?.provider==="${LOCAL_PROVIDER_KEY}"`)],
    [
      "base URL persistence",
      source.includes("baseUrl:ge.base_url||ge.baseUrl")
        || source.includes("baseUrl:he.base_url||he.baseUrl")
    ],
    [
      "prompt base URL",
      source.includes("l.baseUrl?{base_url:l.baseUrl}")
        || source.includes("c.baseUrl?{base_url:c.baseUrl}")
    ],
    [
      "resolved base URL",
      source.includes("a.baseUrl?{base_url:a.baseUrl}")
        || source.includes("l.baseUrl?{base_url:l.baseUrl}")
    ],
    [
      "remote announcements disabled",
      source.includes(`${PATCH_MARKER_V5}: announcements disabled`)
    ],
    [
      "integrity warning disabled",
      source.includes(`${PATCH_MARKER_V6}: integrity warning disabled`)
    ],
    [
      "managed custom model synchronization",
      source.includes(`${PATCH_MARKER_V7}: managed custom models`)
        && source.includes('t.provider!=="qoder-local-gateway"')
        && managedModels.every((model) => source.includes(`"model":"${model.model}"`))
    ]
  ];
  const missing = checks.filter(([, passed]) => !passed).map(([name]) => name);
  if (missing.length) {
    throw new Error(`${filePath}: missing patch assertions: ${missing.join(", ")}`);
  }
  if (source !== original) fs.writeFileSync(filePath, source);
  return { filePath, changed: source !== original };
}

function replaceInjectedModels(source, managedModelsJson) {
  const methodStart = source.indexOf("_readModelsFromStorage(){");
  const methodEnd = source.indexOf("}_loadModels(){", methodStart);
  if (methodStart < 0 || methodEnd < 0) {
    throw new Error("Qoder custom model storage reader was not found");
  }
  const replacement =
    `_readModelsFromStorage(){/* ${PATCH_MARKER_V7}: managed custom models */` +
    `try{const e=this._storageService.get(PFo,-1),n=e?JSON.parse(e):[];` +
    `if(Array.isArray(n))return[...n.filter(t=>t.provider!=="${LOCAL_PROVIDER_KEY}"),...${managedModelsJson}]}` +
    `catch(e){this._logService.error("CustomModelService: Failed to load models from storage",e)}return[]}`;
  return `${source.slice(0, methodStart)}${replacement}${source.slice(methodEnd + 1)}`;
}

function replaceInjectedProvider(source, providerJson) {
  const providerStart =
    `providers:[...e.providers.filter(t=>t.key!=="${LOCAL_PROVIDER_KEY}"),`;
  const providerEnd = "]}}async _waitForByokRequestReady";
  const start = source.indexOf(providerStart);
  if (start < 0) return source;
  const end = source.indexOf(providerEnd, start);
  if (end < 0) return source;
  return `${source.slice(0, start)}${providerStart}${providerJson}${source.slice(end)}`;
}

function patchMainRuntime(filePath) {
  let source = fs.readFileSync(filePath, "utf8");
  const original = source;
  source = source.replace(
    'get disableUpdates(){return!!this.args["disable-updates"]}',
    `get disableUpdates(){return!0}/* ${PATCH_MARKER_V5}: updates disabled */`
  );
  source = source.replace(
    'async checkForUpdates(e){this.logService.trace("update#checkForUpdates, state = ",this.state.type),this.state.type==="idle"&&(this.telemetryService.publicLog2("update:checkForUpdates"),this.doCheckForUpdates(e))}',
    `async checkForUpdates(e){return}/* ${PATCH_MARKER_V5}: manual update checks disabled */`
  );
  source = source.replace(
    'async checkForUpdates(e){this.logService.trace("update#checkForUpdates, state = ",this.state.type),this.state.type==="idle"&&this.doCheckForUpdates(e)}',
    `async checkForUpdates(e){return}/* ${PATCH_MARKER_V5}: manual update checks disabled */`
  );
  source = source.replace(
    "async showNotification(e){const{onlyWhenInactive",
    `async showNotification(e){return"";/* ${PATCH_MARKER_V5}: system push disabled */const{onlyWhenInactive`
  );
  const checks = [
    ["updates disabled", source.includes(`${PATCH_MARKER_V5}: updates disabled`)],
    ["manual update checks disabled", source.includes(`${PATCH_MARKER_V5}: manual update checks disabled`)],
    ["system push disabled", source.includes(`${PATCH_MARKER_V5}: system push disabled`)]
  ];
  const missing = checks.filter(([, passed]) => !passed).map(([name]) => name);
  if (missing.length) {
    throw new Error(`${filePath}: missing runtime patch assertions: ${missing.join(", ")}`);
  }
  if (source !== original) fs.writeFileSync(filePath, source);
  return { filePath, changed: source !== original };
}

function patchProduct(filePath) {
  const originalSource = fs.readFileSync(filePath, "utf8");
  const product = JSON.parse(originalSource);
  if (Object.prototype.hasOwnProperty.call(product, "updateUrl")) {
    product.updateUrl = "";
  }
  if (Object.prototype.hasOwnProperty.call(product, "skipReleaseNotes")) {
    product.skipReleaseNotes = true;
  }
  const next = JSON.stringify(product, null, 2) + "\n";
  if (next !== originalSource) fs.writeFileSync(filePath, next);
  return { filePath, changed: next !== originalSource };
}

const LOCAL_GATEWAY_HANDLER_V8 = String.raw`async _handleLocalGatewayPrompt(e){const sessionId=e.sessionId,metadata=e._meta||{},requestId=metadata?.[s.Constants.ACP_META_KEYS.REQUEST_ID]||"",customModel=metadata?.[s.Constants.ACP_META_KEYS.CUSTOM_MODEL],baseUrl=customModel?.parameters?.base_url?.replace(/\/+$/,""),endpoint=baseUrl?baseUrl+"/responses":null;try{if(!endpoint)throw new Error("local gateway base URL is missing");const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({model:customModel.model,input:this._localGatewayInput(e.prompt||[{type:"text",text:e.message||e.content||""}]),stream:!0,metadata:{qoder_bridge:!0,qoder_bridge_stream_fallback:!0}})});if(!response.ok){const detail=await response.text();throw new Error("local gateway request failed with status "+response.status+(detail?" "+detail.slice(0,400):""))}const contentType=response.headers.get("content-type")||"";if(response.body&&/text\/event-stream/i.test(contentType)){const reader=response.body.getReader(),decoder=new TextDecoder(),state={buffer:"",finished:!1};const processFrame=async frame=>{const data=frame.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");if(!data||data==="[DONE]")return;let value;try{value=JSON.parse(data)}catch{return}const type=value?.type||"";if(type==="response.created"){await this._emitLocalGatewayProgress(sessionId,requestId,"")}else if(type==="response.output_text.delta"){await this._emitLocalGatewayProgress(sessionId,requestId,String(value.delta??""))}else if(type==="response.output_text.done"&&typeof value.text==="string"&&value.text){await this._emitLocalGatewayProgress(sessionId,requestId,value.text)}else if(type==="response.completed"){state.finished=!0}else if(type==="response.failed"){throw new Error("upstream response failed"+(value.error?.message?": "+String(value.error.message).slice(0,400):""))}};for(;;){const chunk=await reader.read();if(chunk.done)break;state.buffer+=decoder.decode(chunk.value,{stream:!0});for(;;){const separator=state.buffer.search(/\r?\n\r?\n/);if(separator<0)break;const boundary=state.buffer.match(/\r?\n\r?\n/)[0],frame=state.buffer.slice(0,separator);state.buffer=state.buffer.slice(separator+boundary.length);await processFrame(frame);if(state.finished){await reader.cancel();state.buffer="";break}}if(state.finished)break}state.buffer+=decoder.decode();if(!state.finished&&state.buffer)await processFrame(state.buffer);await this._emitLocalGatewayProgress(sessionId,requestId,"",!0);return{}}const payload=await response.json(),text=typeof payload.output_text==="string"?payload.output_text:(payload.output||[]).flatMap(item=>item?.content||[]).filter(part=>part?.type==="output_text"||part?.type==="text").map(part=>part.text||"").join("");await this._emitLocalGatewayProgress(sessionId,requestId,text,!0);return{}}catch(error){return await this.handleRequestError("session/prompt",{sessionId,_meta:metadata},error,"request"),{}}}`;
const LOCAL_GATEWAY_PROGRESS_V8 = String.raw`async _emitLocalGatewayProgress(sessionId,requestId,text,done=!1){if(typeof text==="string"&&(text||!done)){const progress={sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text},timestamp:Date.now()},_meta:{[s.Constants.ACP_META_KEYS.REQUEST_ID]:requestId,[s.Constants.ACP_META_KEYS.CONTENT_STREAMED]:!0}};await o.Global.chatIntegration?.handleChatProgress("session/update",sessionId,requestId,progress)}if(done){await o.Global.chatIntegration?.handleChatProgress("session/prompt",sessionId,requestId,{stopReason:"end_turn",_meta:{[s.Constants.ACP_META_KEYS.REQUEST_ID]:requestId}});await o.Global.chatIntegration?.handleChatProgress("session/update",sessionId,requestId,{update:{sessionUpdate:"notification",type:"chat_finish",data:{requestId,sessionId,reason:"completed",statusCode:200}},_meta:{[s.Constants.ACP_META_KEYS.REQUEST_ID]:requestId}})}}`;

const LOCAL_GATEWAY_EXTENSION_METHODS = [
  "_isLocalGatewayPrompt(e){const t=e?._meta?.[s.Constants.ACP_META_KEYS.CUSTOM_MODEL];return!!t&&t.provider===\"qoder-local-gateway\"&&typeof t.model===\"string\"&&typeof t.parameters?.base_url===\"string\"&&/^https?:\\/\\/(?:127\\.0\\.0\\.1|localhost|\\[::1\\])(?::\\d+)?(?:\\/|$)/.test(t.parameters.base_url)}",
  "_localGatewayInput(e){const t=Array.isArray(e)?e:[{type:\"text\",text:String(e??\"\")}],r=[];for(const e of t){if(e?.type===\"text\"){const t=typeof e.text===\"string\"?e.text:typeof e.content===\"string\"?e.content:\"\";t&&r.push({role:\"user\",content:[{type:\"input_text\",text:t}]})}else if(e?.type===\"image\"&&typeof e.data===\"string\"){r.push({role:\"user\",content:[{type:\"input_image\",image_url:`data:${e.mimeType||\"image/png\"};base64,${e.data}`}]})}else if(e?.type===\"resource\"&&typeof e.text===\"string\"){r.push({role:\"user\",content:[{type:\"input_text\",text:e.text}]})}}return r.length?r:[{role:\"user\",content:[{type:\"input_text\",text:\"\"}]}]}",
  LOCAL_GATEWAY_HANDLER_V8,
  LOCAL_GATEWAY_PROGRESS_V8
].join("");

const LOCAL_GATEWAY_HANDLER_V12 = String.raw`async _handleLocalGatewayPrompt(e){
const sessionId=e.sessionId,metadata=e._meta||{},requestId=metadata?.[s.Constants.ACP_META_KEYS.REQUEST_ID]||"",customModel=metadata?.[s.Constants.ACP_META_KEYS.CUSTOM_MODEL],baseUrl=customModel?.parameters?.base_url?.replace(/\/+$/,""),endpoint=baseUrl?baseUrl+"/responses":null,workspacePath=metadata?.["ai-coding/workspace-path"]||"";
const controller=new AbortController;(this.__qoderBridgeControllers??=new Map).set(sessionId,controller);
let input=this._localGatewayInput(e.prompt||[{type:"text",text:e.message||e.content||""}]),round=0;
try{
if(!endpoint)throw new Error("local gateway base URL is missing");
const tools=this._localGatewayTools();
for(;round<3;round+=1){
const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({model:customModel.model,input,tools,tool_choice:"auto",reasoning:customModel.is_reasoning===true?{effort:"medium"}:void 0,stream:!0,metadata:{qoder_bridge:!0,qoder_bridge_tool_mode:"controlled-read-only",workspace_path:workspacePath}}),signal:controller.signal});
if(!response.ok){const detail=await response.text();throw new Error("local gateway request failed with status "+response.status+(detail?" "+detail.slice(0,400):""))}
const parsed=await this._readLocalGatewayResponse(response,sessionId,requestId);
if(!parsed.toolCalls.length){this.__qoderBridgeControllers?.delete(sessionId);await this._emitLocalGatewayProgress(sessionId,requestId,"",!0);return{}}
const functionInputs=[],functionOutputs=[];
for(const call of parsed.toolCalls){
const result=await this._executeLocalGatewayTool(baseUrl,workspacePath,requestId,call,controller.signal);
await this._emitLocalGatewayToolProgress(sessionId,requestId,call,result.ok?"completed":"failed",result.output);
functionInputs.push({type:"function_call",id:call.id,call_id:call.call_id,name:call.name,arguments:call.arguments});
functionOutputs.push({type:"function_call_output",call_id:call.call_id,output:result.output});
}
input=input.concat(functionInputs,functionOutputs);
}
throw new Error("local gateway tool call limit exceeded");
}catch(error){this.__qoderBridgeControllers?.delete(sessionId);return await this.handleRequestError("session/prompt",{sessionId,_meta:metadata},error,"request"),{}}
}

_localGatewayTools(){
return[
{type:"function",name:"read_file",description:"Read a UTF-8 text file inside the current workspace. Read-only.",parameters:{type:"object",properties:{path:{type:"string",description:"Workspace-relative file path"}},required:["path"],additionalProperties:!1}},
{type:"function",name:"list_files",description:"List entries inside the current workspace directory. Read-only.",parameters:{type:"object",properties:{path:{type:"string",description:"Workspace-relative directory path, default ."}},additionalProperties:!1}},
{type:"function",name:"search_text",description:"Search for text in one UTF-8 file inside the current workspace. Read-only.",parameters:{type:"object",properties:{path:{type:"string",description:"Workspace-relative file path"},query:{type:"string",description:"Text to find"}},required:["path","query"],additionalProperties:!1}}
]
}

async _readLocalGatewayResponse(response,sessionId,requestId){
const contentType=response.headers.get("content-type")||"";
if(!(response.body&&/text\/event-stream/i.test(contentType))){
const value=await response.json(),text=typeof value.output_text==="string"?value.output_text:(value.output||[]).flatMap(item=>item?.content||[]).filter(part=>part?.type==="output_text"||part?.type==="text").map(part=>part.text||"").join("");
if(text)await this._emitLocalGatewayProgress(sessionId,requestId,text);
return{toolCalls:await this._localGatewayToolCallsFromValue(value,sessionId,requestId)}
}
const reader=response.body.getReader(),decoder=new TextDecoder(),state={buffer:"",finished:!1,textDeltaSeen:!1,reasoningDeltaSeen:!1,calls:new Map()};
const ensureCall=async(value,emit=!0)=>{
const item=value?.item&&typeof value.item==="object"?value.item:value||{},id=item.call_id||item.id||value?.call_id||value?.item_id;
if(!id)return null;
const call=state.calls.get(String(id))
||[...state.calls.values()].find(existing=>(
existing.id===item.id
|| existing.call_id===item.call_id
|| existing.id===value?.item_id
|| existing.call_id===value?.call_id
))
||{id:item.id||String(id),call_id:item.call_id||value?.call_id||String(id),name:"",arguments:"",emitted:!1};
if(item.name)call.name=item.name;
if(item.arguments!==void 0)call.arguments=typeof item.arguments==="string"?item.arguments:JSON.stringify(item.arguments??{});
if(value?.delta)call.arguments+=String(value.delta);
if(value?.arguments!==void 0)call.arguments=typeof value.arguments==="string"?value.arguments:JSON.stringify(value.arguments??{});
state.calls.set(String(id),call);
if(emit&&call.name&&!call.emitted){call.emitted=!0;await this._emitLocalGatewayToolProgress(sessionId,requestId,call,"in_progress","",!0)}
else if(!emit&&call.name&&call.emitted)await this._emitLocalGatewayToolProgress(sessionId,requestId,call,"in_progress","",!1)
return call
};
const processFrame=async frame=>{
const data=frame.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
if(!data||data==="[DONE]")return;
let value;try{value=JSON.parse(data)}catch{return}
const type=value?.type||"";
if(type==="response.output_text.delta"){const delta=String(value.delta??"");state.textDeltaSeen=state.textDeltaSeen||!!delta;await this._emitLocalGatewayProgress(sessionId,requestId,delta)}
else if(type==="response.output_text.done"&&!state.textDeltaSeen&&typeof value.text==="string"&&value.text)await this._emitLocalGatewayProgress(sessionId,requestId,value.text)
else if(type==="response.reasoning_summary_text.delta"||type==="response.reasoning_text.delta"){const delta=String(value.delta??"");state.reasoningDeltaSeen=state.reasoningDeltaSeen||!!delta;await this._emitLocalGatewayReasoningProgress(sessionId,requestId,delta)}
else if((type==="response.reasoning_summary_text.done"||type==="response.reasoning_text.done")&&!state.reasoningDeltaSeen&&typeof value.text==="string"&&value.text)await this._emitLocalGatewayReasoningProgress(sessionId,requestId,value.text)
else if(type==="response.output_item.added"&&value.item?.type==="function_call")await ensureCall(value,!0)
else if(type==="response.function_call_arguments.delta")await ensureCall({item:{id:value.item_id,call_id:value.call_id},delta:value.delta},!1)
else if(type==="response.function_call_arguments.done")await ensureCall({item:{id:value.item_id,call_id:value.call_id},arguments:value.arguments},!1)
else if(type==="response.output_item.done"&&value.item?.type==="function_call")await ensureCall(value,!0)
else if(type==="response.completed"){state.finished=!0;for(const item of value.response?.output||[])if(item?.type==="function_call")await ensureCall({item},!0)}
else if(type==="response.failed")throw new Error("upstream response failed"+(value.error?.message?": "+String(value.error.message).slice(0,400):""))
else if(type==="response.incomplete")throw new Error("upstream response incomplete"+(value.response?.incomplete_details?.reason?": "+String(value.response.incomplete_details.reason).slice(0,200):""))
};
for(;;){const chunk=await reader.read();if(chunk.done)break;state.buffer+=decoder.decode(chunk.value,{stream:!0});for(;;){const separator=state.buffer.search(/\r?\n\r?\n/);if(separator<0)break;const boundary=state.buffer.match(/\r?\n\r?\n/)[0],frame=state.buffer.slice(0,separator);state.buffer=state.buffer.slice(separator+boundary.length);await processFrame(frame);if(state.finished){await reader.cancel();state.buffer="";break}}if(state.finished)break}
state.buffer+=decoder.decode();if(!state.finished&&state.buffer)await processFrame(state.buffer);if(!state.finished)throw new Error("local gateway SSE ended before response.completed");
return{toolCalls:[...new Set(state.calls.values())].filter(call=>call.name)}
}

async _localGatewayToolCallsFromValue(value,sessionId,requestId){
const calls=[];
for(const item of value?.output||[])if(item?.type==="function_call"&&item.name){const call={id:item.id||item.call_id,call_id:item.call_id||item.id,name:item.name,arguments:typeof item.arguments==="string"?item.arguments:JSON.stringify(item.arguments??{})};calls.push(call);await this._emitLocalGatewayToolProgress(sessionId,requestId,call,"in_progress","",!0)}
return calls
}

async _executeLocalGatewayTool(baseUrl,workspacePath,requestId,call,signal){
const gatewayRoot=String(baseUrl||"").replace(/\/v1\/?$/,"");
const endpoint=gatewayRoot+"/admin/local-tool";
try{
const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({request_id:requestId,workspace_path:workspacePath,tool_call:{id:call.id,call_id:call.call_id,type:"function",function:{name:call.name,arguments:call.arguments}}}),signal});
const value=await response.json().catch(()=>({error:"local tool returned invalid JSON"}));
const output=typeof value.content==="string"?value.content:JSON.stringify(value.content??value.error??value);
return{ok:response.ok&&value.ok===true,output}
}catch(error){return{ok:!1,output:String(error?.message||"local tool execution failed").slice(0,400)}}
}

async _emitLocalGatewayToolProgress(sessionId,requestId,call,status,detail,initial=!1){
let rawInput={};try{const parsed=JSON.parse(call.arguments||"{}");if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))rawInput=parsed}catch{}
const update={sessionId,update:{sessionUpdate:initial?"tool_call":"tool_call_update",sessionId,toolCallId:call.call_id||call.id,title:call.name,kind:"other",rawInput,status},_meta:{[s.Constants.ACP_META_KEYS.REQUEST_ID]:requestId}};
if(status!=="in_progress"){const text=String(detail||"").slice(0,1200),content=text?[{type:"content",content:{type:"text",text}}]:[];update.update.rawOutput=content;update.update.content=content}
await o.Global.chatIntegration?.handleChatProgress("session/update",sessionId,requestId,update)
}

async _emitLocalGatewayReasoningProgress(sessionId,requestId,text){
if(typeof text!=="string"||!text)return;
const progress={sessionId,update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text},timestamp:Date.now()},_meta:{[s.Constants.ACP_META_KEYS.REQUEST_ID]:requestId,[s.Constants.ACP_META_KEYS.CONTENT_STREAMED]:!0}};
await o.Global.chatIntegration?.handleChatProgress("session/update",sessionId,requestId,progress)
}`;

function patchExtension(filePath) {
  let source = fs.readFileSync(filePath, "utf8");
  const original = source;
  if (!source.includes("_isLocalGatewayPrompt") && !source.includes(PATCH_MARKER)) {
    const handlerNeedle =
      "async handleACPSessionPrompt(e,t){return this._handleSessionPrompt(t)}";
    const handlerReplacement =
      `async handleACPSessionPrompt(e,t){return this._isLocalGatewayPrompt(t)?this._handleLocalGatewayPrompt(t):this._handleSessionPrompt(t)}${LOCAL_GATEWAY_EXTENSION_METHODS}`;
    if (!source.includes(handlerNeedle)) {
      throw new Error(`${filePath}: ACP prompt handler was not found`);
    }
    source = source.replace(handlerNeedle, handlerReplacement);
    source += `\n/* ${PATCH_MARKER} */\n`;
  }
  if (source.includes("_isLocalGatewayPrompt")) {
    if (!source.includes(PATCH_MARKER_V12)) {
      const handlerPattern =
        /async _handleLocalGatewayPrompt\(e\)\{.*?\}(?=async _emitLocalGatewayProgress)/s;
      if (!handlerPattern.test(source)) {
        throw new Error(`${filePath}: local gateway V12 handler was not found`);
      }
      source = source.replace(
        handlerPattern,
        `${LOCAL_GATEWAY_HANDLER_V12}\n\n`
      );
      source += `\n/* ${PATCH_MARKER_V12} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V9)) {
      source = source.replace(
        'state={buffer:"",finished:!1}',
        'state={buffer:"",finished:!1,deltaSeen:!1}'
      );
      source = source.replace(
        'else if(type==="response.output_text.delta"){await this._emitLocalGatewayProgress(sessionId,requestId,String(value.delta??""))}',
        'else if(type==="response.output_text.delta"){const delta=String(value.delta??"");state.deltaSeen=state.deltaSeen||!!delta;await this._emitLocalGatewayProgress(sessionId,requestId,delta)}'
      );
      source = source.replace(
        'else if(type==="response.output_text.done"&&typeof value.text==="string"&&value.text){await this._emitLocalGatewayProgress(sessionId,requestId,value.text)}',
        'else if(type==="response.output_text.done"&&!state.deltaSeen&&typeof value.text==="string"&&value.text){await this._emitLocalGatewayProgress(sessionId,requestId,value.text)}'
      );
      source = source.replace(
        'else if(type==="response.failed"){throw new Error("upstream response failed"+(value.error?.message?": "+String(value.error.message).slice(0,400):""))}',
        'else if(type==="response.failed"){throw new Error("upstream response failed"+(value.error?.message?": "+String(value.error.message).slice(0,400):""))}else if(type==="response.incomplete"){throw new Error("upstream response incomplete"+(value.response?.incomplete_details?.reason?": "+String(value.response.incomplete_details.reason).slice(0,200):""))}else if(type==="response.output_item.added"&&value.item?.type==="function_call"){throw new Error("local gateway tool calls are not supported by the Qoder prompt bridge")}'
      );
      source = source.replace(
        'state.buffer+=decoder.decode();if(!state.finished&&state.buffer)await processFrame(state.buffer);await this._emitLocalGatewayProgress(sessionId,requestId,"",!0);return{}',
        'state.buffer+=decoder.decode();if(!state.finished&&state.buffer)await processFrame(state.buffer);if(!state.finished)throw new Error("local gateway SSE ended before response.completed");await this._emitLocalGatewayProgress(sessionId,requestId,"",!0);return{}'
      );
      source += `\n/* ${PATCH_MARKER_V9} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V10)) {
      source = source.replace(
        'async handleACPSessionCancel(e,t){return this._handleSessionCancel(t)}',
        'async handleACPSessionCancel(e,t){return this._isLocalGatewayPrompt(t)?this._cancelLocalGatewayPrompt(t):this._handleSessionCancel(t)}'
      );
      source = source.replace(
        'async _handleLocalGatewayPrompt(e)',
        '_cancelLocalGatewayPrompt(e){const t=e?.sessionId,r=this.__qoderBridgeControllers?.get(t);return r&&(r.abort(new Error("session cancelled")),this.__qoderBridgeControllers.delete(t)),{}}async _handleLocalGatewayPrompt(e)'
      );
      source = source.replace(
        'endpoint=baseUrl?baseUrl+"/responses":null;try{',
        'endpoint=baseUrl?baseUrl+"/responses":null;const controller=new AbortController;(this.__qoderBridgeControllers??=new Map).set(sessionId,controller);try{'
      );
      source = source.replace(
        'metadata:{qoder_bridge:!0,qoder_bridge_stream_fallback:!0}})});',
        'metadata:{qoder_bridge:!0,qoder_bridge_stream_fallback:!0}}),signal:controller.signal});'
      );
      source = source.replace(
        'await this._emitLocalGatewayProgress(sessionId,requestId,"",!0);return{}}const payload=',
        'this.__qoderBridgeControllers?.delete(sessionId);await this._emitLocalGatewayProgress(sessionId,requestId,"",!0);return{}}const payload='
      );
      source = source.replace(
        'await this._emitLocalGatewayProgress(sessionId,requestId,text,!0);return{}}catch(error){',
        'this.__qoderBridgeControllers?.delete(sessionId);await this._emitLocalGatewayProgress(sessionId,requestId,text,!0);return{}}catch(error){'
      );
      source = source.replace(
        'catch(error){return await this.handleRequestError("session/prompt",{sessionId,_meta:metadata},error,"request"),{}}}',
        'catch(error){this.__qoderBridgeControllers?.delete(sessionId);return await this.handleRequestError("session/prompt",{sessionId,_meta:metadata},error,"request"),{}}}'
      );
      source += `\n/* ${PATCH_MARKER_V10} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V11)) {
      // V8 accidentally changed both the local bridge event and Qoder's
      // native transcript helper to ACP array content. Qoder's renderer and
      // history loader require the ACP text content object shape.
      source = source.replace(
        'update:{sessionUpdate:"agent_message_chunk",content:[{type:"text",text}],timestamp:Date.now()}',
        'update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text},timestamp:Date.now()}'
      );
      source = source.replace(
        'content:[{type:"text",text:r}]',
        'content:{type:"text",text:r}'
      );
      source += `\n/* ${PATCH_MARKER_V11} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V9) && !source.includes(LOCAL_GATEWAY_HANDLER_V8)) {
      const handlerPattern =
        /async _handleLocalGatewayPrompt\(e\)\{.*?\}(?=async _emitLocalGatewayProgress)/s;
      if (handlerPattern.test(source)) {
        source = source.replace(handlerPattern, LOCAL_GATEWAY_HANDLER_V8);
      } else {
        throw new Error(`${filePath}: local gateway handler was not found`);
      }
    }
    if (!source.includes(PATCH_MARKER_V9) && !source.includes(LOCAL_GATEWAY_PROGRESS_V8)) {
      const progressPattern =
        /async _emitLocalGatewayProgress\([^)]*\)\{.*?\}(?=async [A-Za-z_$])/s;
      if (progressPattern.test(source)) {
        source = source.replace(progressPattern, LOCAL_GATEWAY_PROGRESS_V8);
      } else {
        throw new Error(`${filePath}: local gateway progress handler was not found`);
      }
    }
    if (!source.includes(PATCH_MARKER_V8)) {
      source += `\n/* ${PATCH_MARKER_V8} */\n`;
    }
  }
  const checks = [
    ["local gateway selector", source.includes("_isLocalGatewayPrompt")],
    ["local gateway request", source.includes("local gateway request failed")],
    ["local gateway progress", source.includes("_emitLocalGatewayProgress")],
    ["local gateway streaming", source.includes("text/event-stream")],
    ["ACP text content object", source.includes("content:{type:\"text\",text}")]
  ];
  if (source.includes("_isLocalGatewayPrompt")) {
    checks.push([
      "handler variable isolation",
      source.includes("const sessionId=e.sessionId,metadata=e._meta||{},requestId=")
    ]);
    checks.push([
      "Qoder text chunk shape",
      source.includes("content:{type:\"text\",text}")
        && source.includes(PATCH_MARKER_V11)
        && source.includes("CONTENT_STREAMED]:!0")
    ]);
    checks.push([
      "duplicate delta guard",
      source.includes(PATCH_MARKER_V12)
        ? source.includes("textDeltaSeen:!1")
          && source.includes("response.output_text.delta")
        : source.includes(PATCH_MARKER_V9)
          && source.includes("deltaSeen:!1")
          && source.includes("!state.deltaSeen")
    ]);
    checks.push([
      "incomplete stream guard",
      source.includes("local gateway SSE ended before response.completed")
    ]);
    checks.push([
      "Qoder cancellation bridge",
      source.includes(PATCH_MARKER_V10)
        && source.includes("_cancelLocalGatewayPrompt")
        && source.includes("signal:controller.signal")
        && source.includes("session cancelled")
    ]);
    checks.push([
      "Qoder tool roundtrip",
      source.includes(PATCH_MARKER_V12)
        && source.includes("_localGatewayTools")
        && source.includes("_executeLocalGatewayTool")
        && source.includes("function_call_output")
        && source.includes("tool_call_update")
    ]);
    checks.push([
      "Qoder reasoning separation",
      source.includes("_emitLocalGatewayReasoningProgress")
        && source.includes('sessionUpdate:"agent_thought_chunk"')
    ]);
  }
  const missing = checks.filter(([, passed]) => !passed).map(([name]) => name);
  if (missing.length) {
    throw new Error(`${filePath}: missing patch assertions: ${missing.join(", ")}`);
  }
  if (source !== original) fs.writeFileSync(filePath, source);
  return { filePath, changed: source !== original };
}

export async function applyQoderPatch(options = {}) {
  const gatewayUrl = (
    options.gatewayUrl ||
    process.env.QODER_GATEWAY_URL ||
    DEFAULT_GATEWAY_URL
  ).replace(/\/+$/, "");
  const models = await discoverModels(gatewayUrl, options.authorization);
  const provider = providerForModels(models);
  const managedModels = modelRecordsForQoder(models, gatewayUrl);
  const appRoot = findQoderAppRoot(options.appRoot);
  if (!appRoot) {
    throw new Error("Qoder CN installation was not found in /Applications or ~/Applications");
  }
  const targets = [
    `${appRoot}/out/vs/workbench/workbench.desktop.main.js`,
    `${appRoot}/out/lingma/agents-window/agents-window.desktop.main.js`
  ];
  const mainTarget = `${appRoot}/out/main.js`;
  const productTarget = `${appRoot}/product.json`;
  const extensionTarget = `${appRoot}/extensions/aicoding-agent/dist/extension.js`;
  const backupDir = options.backupDir || path.join(
    options.homeDir || process.env.HOME || "/Users/Shared",
    "Library",
    "Application Support",
    "QoderCN",
    "Backups",
    `qoder-gateway-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`
  );

  for (const filePath of [...targets, mainTarget, productTarget, extensionTarget]) {
    backupFile(filePath, backupDir);
  }
  const results = [];
  for (const filePath of targets) {
    results.push(patchMainBundle(filePath, provider, managedModels));
  }
  results.push(patchMainRuntime(mainTarget));
  results.push(patchProduct(productTarget));
  results.push(patchExtension(extensionTarget));
  return {
    gateway: gatewayUrl,
    models: models.map((model) => model.id),
    updates: "disabled",
    system_push: "disabled",
    backup: backupDir,
    files: results.map((result) => ({
      file: result.filePath,
      changed: result.changed
    }))
  };
}
