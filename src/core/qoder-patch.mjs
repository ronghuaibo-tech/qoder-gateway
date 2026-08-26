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
const PATCH_MARKER_V13 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V13";
const PATCH_MARKER_V14 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V14";
const PATCH_MARKER_V15 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V15";
const PATCH_MARKER_V16 = "QODER_BRIDGE_GATEWAY_PATCH_20260825_V16";
const PATCH_MARKER_V17 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V17";
const PATCH_MARKER_V18 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V18";
const PATCH_MARKER_V19 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V19";
const PATCH_MARKER_V20 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V20";
const PATCH_MARKER_V21 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V21";
const PATCH_MARKER_V22 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V22";
const PATCH_MARKER_V23 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V23";
const PATCH_MARKER_V24 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V24";
const PATCH_MARKER_V25 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V25";
const PATCH_MARKER_V26 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V26";
const PATCH_MARKER_V27 = "QODER_BRIDGE_GATEWAY_PATCH_20260826_V27";

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

function contextConfig(model) {
  const values = positiveIntegers(
    model.context_lengths
      ?? model.supported_context_lengths
      ?? model.context_windows
      ?? model.supported_context_windows
  );
  const maxInputTokens = positiveInteger(
    model.max_input_tokens
      ?? model.max_context_tokens
      ?? model.max_context_length
      ?? model.context_window
      ?? model.context_length
  );
  const tokenCounts = values.length ? values : maxInputTokens ? [maxInputTokens] : [];
  if (!tokenCounts.length) return undefined;
  const defaultTokenCount = positiveInteger(
    model.default_context_length
      ?? model.default_max_input_tokens
  );
  return Object.fromEntries(tokenCounts.map((tokenCount, index) => {
    const key = String(tokenCount);
    return [key, {
      label: formatTokenCount(tokenCount),
      tokenCount,
      ...(tokenCount === defaultTokenCount || (
        defaultTokenCount === undefined && index === 0
      ) ? { isDefault: true } : {})
    }];
  }));
}

function thinkingConfig(model) {
  const capabilities = modelCapabilities(model);
  const efforts = modelReasoningEfforts(model);
  if (capabilities.reasoning !== true && efforts.length === 0) return undefined;
  const defaultEffort = typeof model.default_reasoning_effort === "string"
    ? model.default_reasoning_effort.trim().toLowerCase()
    : efforts.includes("medium") ? "medium" : efforts[0];
  const config = {
    enabled: {
      label: "On",
      isReasoning: true,
      isDefault: true,
      ...(defaultEffort ? { defaultEffortKey: defaultEffort } : {}),
      efforts: Object.fromEntries(efforts.map((effort) => [effort, {
        label: formatEffort(effort),
        ...(effort === defaultEffort ? { isDefault: true } : {})
      }]))
    }
  };
  if (model.reasoning_required !== true && model.reasoning_disabled !== false) {
    config.disabled = {
      label: "Off",
      isReasoning: false
    };
  }
  return config;
}

function runtimeModelFields(model) {
  const context = contextConfig(model);
  const thinking = thinkingConfig(model);
  const maxInputTokens = positiveInteger(
    model.max_input_tokens
      ?? model.max_context_tokens
      ?? model.max_context_length
      ?? model.context_window
      ?? model.context_length
  ) ?? Math.max(...Object.values(context ?? {}).map((item) => item.tokenCount), 0);
  return {
    ...(maxInputTokens > 0 ? { max_input_tokens: maxInputTokens } : {}),
    ...(context ? { contextConfig: context } : {}),
    ...(thinking ? { thinkingConfig: thinking } : {})
  };
}

function modelReasoningEfforts(model) {
  return normalizeEfforts(
    model.reasoning_efforts
      ?? model.supported_reasoning_efforts
  );
}

function positiveInteger(value) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function positiveIntegers(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(positiveInteger).filter((item) => item !== undefined))]
    .sort((a, b) => a - b);
}

function normalizeEfforts(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => typeof item === "string" ? item.trim().toLowerCase() : "")
    .filter(Boolean))];
}

function formatTokenCount(value) {
  if (value >= 1000000) {
    const millions = value / 1000000;
    return `${Number.isInteger(millions)
      ? millions
      : millions.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
  }
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`;
  return String(value);
}

function formatEffort(value) {
  return value === "xhigh" ? "xHigh" : value.charAt(0).toUpperCase() + value.slice(1);
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
          is_reasoning: capabilities.reasoning === true
            || modelReasoningEfforts(model).length > 0,
          ...runtimeModelFields(model)
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
      is_reasoning: capabilities.reasoning === true
        || modelReasoningEfforts(model).length > 0,
      ...runtimeModelFields(model),
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

  if (!source.includes(`${PATCH_MARKER_V21}: empty workspace builtin refresh skipped`)) {
    const builtinRefreshNeedle =
      'async _performBuiltinCommandRefresh(e,n,r,i,o,s){this.logger.info("[ACP] Fetching builtin commands via session/new...",{targetAuthority:this._authorityLabel(e),reason:i,cwd:n||"<empty>",workspacePath:r||"<empty>"})';
    if (source.includes(builtinRefreshNeedle)) {
      source = source.replace(
        builtinRefreshNeedle,
        'async _performBuiltinCommandRefresh(e,n,r,i,o,s){if(!n&&!r){this.logger.info("[ACP] Skipping builtin commands refresh for empty workspace",{targetAuthority:this._authorityLabel(e),reason:i});return}this.logger.info("[ACP] Fetching builtin commands via session/new...",{targetAuthority:this._authorityLabel(e),reason:i,cwd:n||"<empty>",workspacePath:r||"<empty>"})'
      );
    } else if (!source.includes("Skipping builtin commands refresh for empty workspace")) {
      throw new Error(`${filePath}: builtin command refresh point was not found`);
    }
    source += `\n/* ${PATCH_MARKER_V21}: empty workspace builtin refresh skipped */\n`;
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
      "empty workspace builtin refresh skipped",
      source.includes(`${PATCH_MARKER_V21}: empty workspace builtin refresh skipped`)
        && source.includes("Skipping builtin commands refresh for empty workspace")
        && source.includes("!n&&!r")
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

const LOCAL_GATEWAY_PROGRESS_V14 = String.raw`async _emitLocalGatewayProgress(sessionId,requestId,text,done=!1){const state=this.__qoderBridgeHistory?.get(sessionId);if(typeof text==="string"&&(text||!done)){if(state&&text)state.assistantText+=text;const progress={sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text},timestamp:Date.now()},_meta:{[s.Constants.ACP_META_KEYS.REQUEST_ID]:requestId,[s.Constants.ACP_META_KEYS.CONTENT_STREAMED]:!0}};await o.Global.chatIntegration?.handleChatProgress("session/update",sessionId,requestId,progress)}if(done){if(state)await this._appendLocalGatewayHistory(sessionId,requestId,state,"Completed");await o.Global.chatIntegration?.handleChatProgress("session/prompt",sessionId,requestId,{stopReason:"end_turn",_meta:{[s.Constants.ACP_META_KEYS.REQUEST_ID]:requestId}});await o.Global.chatIntegration?.handleChatProgress("session/update",sessionId,requestId,{update:{sessionUpdate:"notification",type:"chat_finish",data:{requestId,sessionId,reason:"completed",statusCode:200}},_meta:{[s.Constants.ACP_META_KEYS.REQUEST_ID]:requestId}})}}`;

const LOCAL_GATEWAY_HISTORY_METHOD = String.raw`async _appendLocalGatewayHistory(sessionId,requestId,state,status="Completed"){if(!state||state.persisted)return;state.persisted=!0;const userText=String(state.userText||"").trim(),assistantText=String(state.assistantText||"").trim();if(!userText&&!assistantText){this.__qoderBridgeHistory?.delete(sessionId);return}const now=Date.now(),messages=[];userText&&messages.push({id:requestId+":user",role:"user",content:userText,contentType:"text",createdAt:state.createdAt||now,metadata:{qoderBridge:!0}});assistantText&&messages.push({id:requestId+":assistant",role:"assistant",content:assistantText,contentType:"markdown",createdAt:now,metadata:{qoderBridge:!0}});const title=String(state.title||userText||"Qoder Bridge chat").replace(/\s+/g," ").trim().slice(0,120)||"Qoder Bridge chat",payload={sessionId,requestId,title,workspacePath:state.workspacePath||"",sessionType:"assistant",mode:"agent",status,messages,metadata:{qoderBridge:!0}};try{if(typeof this.sendRequest!=="function")throw new Error("Qoder history request sender is unavailable");await this.sendRequest("session/appendHistoryTurn",payload)}catch(error){console.error("[Qoder Bridge] Failed to persist local gateway history",error?.message||error)}finally{this.__qoderBridgeHistory?.delete(sessionId)}}`;

const LOCAL_GATEWAY_PROGRESS_V16 = String.raw`async _finishLocalGatewayPrompt(sessionId,requestId,state,reason="completed",statusCode=200,stopReason="end_turn"){if(state?.terminalSent)return;state&&(state.terminalSent=!0);const metadata={ [s.Constants.ACP_META_KEYS.REQUEST_ID]:requestId };await o.Global.chatIntegration?.handleChatProgress("session/prompt",sessionId,requestId,{sessionId,stopReason,_meta:metadata});await o.Global.chatIntegration?.handleChatProgress("session/update",sessionId,requestId,{sessionId,update:{sessionUpdate:"notification",sessionId,type:"chat_finish",data:{requestId,sessionId,reason,statusCode}},_meta:metadata});await this._appendLocalGatewayHistory(sessionId,requestId,state,reason==="completed"?"Completed":reason==="cancelled"?"Cancelled":"Failed")}async _emitLocalGatewayProgress(sessionId,requestId,text,done=!1){const state=this.__qoderBridgeHistory?.get(sessionId);if(typeof text==="string"&&(text||!done)){if(state&&text)state.assistantText+=text;const progress={sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text},timestamp:Date.now()},_meta:{[s.Constants.ACP_META_KEYS.REQUEST_ID]:requestId,[s.Constants.ACP_META_KEYS.CONTENT_STREAMED]:!0}};await o.Global.chatIntegration?.handleChatProgress("session/update",sessionId,requestId,progress)}if(done)await this._finishLocalGatewayPrompt(sessionId,requestId,state)}`;

const LOCAL_GATEWAY_HANDLER_V12 = String.raw`async _handleLocalGatewayPrompt(e){
const sessionId=e.sessionId,metadata=e._meta||{},requestId=metadata?.[s.Constants.ACP_META_KEYS.REQUEST_ID]||"",runtimeConfig=metadata?.["ai-coding/model_config"]||{},customModel=metadata?.[s.Constants.ACP_META_KEYS.CUSTOM_MODEL],baseUrl=customModel?.parameters?.base_url?.replace(/\/+$/,""),endpoint=baseUrl?baseUrl+"/responses":null,workspacePath=metadata?.["ai-coding/workspace-path"]||"",contextLength=Number.isInteger(runtimeConfig.max_input_tokens)&&runtimeConfig.max_input_tokens>0?runtimeConfig.max_input_tokens:Number.isInteger(customModel?.max_input_tokens)&&customModel.max_input_tokens>0?customModel.max_input_tokens:void 0,reasoningEffort=typeof runtimeConfig.reasoning_effort==="string"&&runtimeConfig.reasoning_effort?runtimeConfig.reasoning_effort:customModel?.is_reasoning===true?"medium":void 0;
const controller=new AbortController;(this.__qoderBridgeControllers??=new Map).set(sessionId,controller);
const promptParts=e.prompt||[{type:"text",text:e.message||e.content||""}],history={userText:this._localGatewayInput(promptParts).flatMap(item=>item.content||[]).map(part=>part.text||"").join("\n"),assistantText:"",createdAt:Date.now(),title:metadata?.["ai-coding/task-title"]||metadata?.["ai-coding/title"],workspacePath};(this.__qoderBridgeHistory??=new Map).set(sessionId,history);
let input=this._localGatewayInput(promptParts),round=0,totalToolCalls=0;
const seenToolCalls=new Map,toolResults=new Map,MAX_TOOL_ROUNDS=8,MAX_TOOL_CALLS=24,MAX_DUPLICATE_TOOL_CALLS=2,ensureActive=()=>{if(controller.signal.aborted)throw new Error("session cancelled")};
const finishPrompt=(text="")=>this._emitLocalGatewayProgress(sessionId,requestId,text,!0);
const failPrompt=async(text)=>{const state=this.__qoderBridgeHistory?.get(sessionId);this.__qoderBridgeControllers?.delete(sessionId);if(text)await this._emitLocalGatewayProgress(sessionId,requestId,text);await this._finishLocalGatewayPrompt(sessionId,requestId,state,"failed",500,"end_turn")};
try{
if(!endpoint)throw new Error("local gateway base URL is missing");
const tools=this._localGatewayTools();
for(;round<MAX_TOOL_ROUNDS;round+=1){
ensureActive();
const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({model:customModel.model,input,tools,tool_choice:"auto",context_length:contextLength,reasoning:reasoningEffort?{effort:reasoningEffort}:void 0,stream:!0,metadata:{qoder_bridge:!0,qoder_bridge_tool_mode:"controlled-read-only",workspace_path:workspacePath}}),signal:controller.signal});
if(!response.ok){const detail=await response.text();throw new Error("local gateway request failed with status "+response.status+(detail?" "+detail.slice(0,400):""))}
ensureActive();
const parsed=await this._readLocalGatewayResponse(response,sessionId,requestId,controller.signal);
ensureActive();
if(!parsed.toolCalls.length){this.__qoderBridgeControllers?.delete(sessionId);await finishPrompt("");return{}}
const functionInputs=[],functionOutputs=[];
for(const call of parsed.toolCalls){
ensureActive();
totalToolCalls+=1;
if(totalToolCalls>MAX_TOOL_CALLS){const output="tool loop limit reached after "+MAX_TOOL_CALLS+" calls; summarize from previous tool results and stop calling tools";await this._emitLocalGatewayToolProgress(sessionId,requestId,call,"failed",output);functionInputs.push({type:"function_call",id:call.id,call_id:call.call_id,name:call.name,arguments:call.arguments});functionOutputs.push({type:"function_call_output",call_id:call.call_id,output:output});input=input.concat(functionInputs,functionOutputs);break}
const signature=this._localGatewayToolSignature(call),seenCount=(seenToolCalls.get(signature)||0)+1;seenToolCalls.set(signature,seenCount);
let result;
if(seenCount>MAX_DUPLICATE_TOOL_CALLS&&toolResults.has(signature)){
const previous=toolResults.get(signature);
result={ok:previous.ok,output:"repeated tool call reused previous result; change path/query if you need new data\n"+previous.output};
await this._emitLocalGatewayToolProgress(sessionId,requestId,call,previous.ok?"completed":"failed",result.output);
}else{
result=await this._executeLocalGatewayTool(baseUrl,workspacePath,requestId,call,controller.signal);
ensureActive();
toolResults.set(signature,result);
await this._emitLocalGatewayToolProgress(sessionId,requestId,call,result.ok?"completed":"failed",result.output);
}
functionInputs.push({type:"function_call",id:call.id,call_id:call.call_id,name:call.name,arguments:call.arguments});
functionOutputs.push({type:"function_call_output",call_id:call.call_id,output:result.output});
}
input=input.concat(functionInputs,functionOutputs);
}
this.__qoderBridgeControllers?.delete(sessionId);await finishPrompt("\n\n[Qoder Bridge] Stopped after "+MAX_TOOL_ROUNDS+" local tool rounds. Please summarize from the tool results already returned, or ask for a narrower search.");return{}
}catch(error){const cancelled=/cancel/i.test(String(error?.message||""))||error?.name==="AbortError";this.__qoderBridgeControllers?.delete(sessionId);if(cancelled){const state=this.__qoderBridgeHistory?.get(sessionId);await this._finishLocalGatewayPrompt(sessionId,requestId,state,"cancelled",499,"cancelled");return{}}await failPrompt("\n\n[Qoder Bridge] "+String(error?.message||error).slice(0,400));return{}}
}

_localGatewayTools(){
return[
{type:"function",name:"read_file",description:"Read a UTF-8 text file inside the current Qoder folder. Requires an opened workspace. Do not retry the same path if it fails. Read-only.",parameters:{type:"object",properties:{path:{type:"string",description:"Workspace-relative file path"}},required:["path"],additionalProperties:!1}},
{type:"function",name:"list_files",description:"List entries inside the current Qoder folder. Requires an opened workspace. If the workspace is empty or missing, tell the user to open a folder; do not call list_files again with the same path. Read-only.",parameters:{type:"object",properties:{path:{type:"string",description:"Workspace-relative directory path, default ."}},additionalProperties:!1}},
{type:"function",name:"search_text",description:"Search for text in one UTF-8 file inside the current Qoder folder. Requires an opened workspace. Read-only.",parameters:{type:"object",properties:{path:{type:"string",description:"Workspace-relative file path"},query:{type:"string",description:"Text to find"}},required:["path","query"],additionalProperties:!1}},
{type:"function",name:"list_qoder_plugins",description:"List Qoder plugin bundles (skills, MCP, agents, commands) from the local plugin cache. Use this for plugin questions even when no workspace folder is open. Read-only.",parameters:{type:"object",properties:{query:{type:"string",description:"Optional search text"}},additionalProperties:!1}},
{type:"function",name:"list_qoder_plugin_files",description:"List entries inside one Qoder plugin bundle. Read-only.",parameters:{type:"object",properties:{plugin:{type:"string",description:"Plugin name"},path:{type:"string",description:"Plugin-relative directory path, default ."}},required:["plugin"],additionalProperties:!1}},
{type:"function",name:"read_qoder_plugin_file",description:"Read a UTF-8 text file from one Qoder plugin bundle. Read-only.",parameters:{type:"object",properties:{plugin:{type:"string",description:"Plugin name"},path:{type:"string",description:"Plugin-relative file path"}},required:["plugin","path"],additionalProperties:!1}},
{type:"function",name:"search_qoder_plugins",description:"Search text inside Qoder plugin bundle metadata and docs. Read-only.",parameters:{type:"object",properties:{query:{type:"string",description:"Text to find"}},required:["query"],additionalProperties:!1}}
]
}

async _readLocalGatewayResponse(response,sessionId,requestId,signal){
const ensureActive=()=>{if(signal?.aborted)throw new Error("session cancelled")};
const contentType=response.headers.get("content-type")||"";
if(!(response.body&&/text\/event-stream/i.test(contentType))){
ensureActive();
const value=await response.json(),text=typeof value.output_text==="string"?value.output_text:(value.output||[]).flatMap(item=>item?.content||[]).filter(part=>part?.type==="output_text"||part?.type==="text").map(part=>part.text||"").join("");
ensureActive();if(text)await this._emitLocalGatewayProgress(sessionId,requestId,text);
return{toolCalls:await this._localGatewayToolCallsFromValue(value,sessionId,requestId)}
}
const reader=response.body.getReader(),decoder=new TextDecoder(),state={buffer:"",finished:!1,textDeltaSeen:!1,reasoningDeltaSeen:!1,calls:new Map()};
const ensureCall=async(value,emit=!0)=>{
ensureActive();
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
ensureActive();
const data=frame.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
if(!data||data==="[DONE]")return;
let value;try{value=JSON.parse(data)}catch{return}
ensureActive();
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
for(;;){ensureActive();const chunk=await reader.read();ensureActive();if(chunk.done)break;state.buffer+=decoder.decode(chunk.value,{stream:!0});for(;;){const separator=state.buffer.search(/\r?\n\r?\n/);if(separator<0)break;const boundary=state.buffer.match(/\r?\n\r?\n/)[0],frame=state.buffer.slice(0,separator);state.buffer=state.buffer.slice(separator+boundary.length);await processFrame(frame);if(state.finished){await reader.cancel();state.buffer="";break}}if(state.finished)break}
ensureActive();state.buffer+=decoder.decode();if(!state.finished&&state.buffer)await processFrame(state.buffer);if(!state.finished)throw new Error("local gateway SSE ended before response.completed");
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
const rawOutput=typeof value.content==="string"?value.content:JSON.stringify(value.content??value.error??value);
const output=this._compactLocalGatewayToolOutput(call.name,rawOutput);
return{ok:response.ok&&value.ok===true,output}
}catch(error){return{ok:!1,output:String(error?.message||"local tool execution failed").slice(0,400)}}
}

_localGatewayToolSignature(call){
const argText=String(call?.arguments??"").trim();
let normalizedArgs=argText||"{}";
try{const parsed=JSON.parse(normalizedArgs);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed)){normalizedArgs=JSON.stringify(Object.fromEntries(Object.keys(parsed).sort().map(key=>[key,parsed[key]])))}}
catch{}
return String(call?.name||"")+" "+normalizedArgs
}

_compactLocalGatewayToolOutput(name,output){
let text=String(output??""),value;
try{value=JSON.parse(text)}catch{}
if(value&&typeof value==="object"){
if(name==="list_files"&&Array.isArray(value.entries)){const entries=value.entries.slice(0,40);text=JSON.stringify({path:value.path,total:value.total??value.entries.length,shown:entries.length,truncated:value.truncated===true||value.entries.length>entries.length,entries,hint:"Pass a narrower path to list_files, or read specific files with read_file."})}
else if(name==="search_text"&&Array.isArray(value.matches)){const matches=value.matches.slice(0,40);text=JSON.stringify({path:value.path,total:value.total??value.matches.length,shown:matches.length,truncated:value.truncated===true||value.matches.length>matches.length,matches,hint:"Pass a narrower file or query if more context is needed."})}
else if(name==="list_qoder_plugins"&&Array.isArray(value.plugins)){const plugins=value.plugins.slice(0,30);text=JSON.stringify({total:value.total??value.plugins.length,shown:plugins.length,truncated:value.truncated===true||value.plugins.length>plugins.length,plugins,hint:"Use search_qoder_plugins or a plugin name to narrow the cache."})}
else if(name==="list_qoder_plugin_files"&&Array.isArray(value.entries)){const entries=value.entries.slice(0,40);text=JSON.stringify({plugin:value.plugin,path:value.path,total:value.total??value.entries.length,shown:entries.length,truncated:value.truncated===true||value.entries.length>entries.length,entries,hint:"Use a narrower plugin path or read specific files."})}
else if(name==="search_qoder_plugins"&&Array.isArray(value.matches)){const matches=value.matches.slice(0,40);text=JSON.stringify({query:value.query,total:value.total??value.matches.length,shown:matches.length,truncated:value.truncated===true||value.matches.length>matches.length,matches,hint:"Read the matched plugin file directly if more context is needed."})}
}
if(text.length>12000)text=text.slice(0,12000)+"\n...[truncated by Qoder Bridge; narrow the path/query or read a smaller file]...";
return text
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
    if (!source.includes(PATCH_MARKER_V13)) {
      const oldRoundLimit = "for(;round<3;round+=1)";
      if (source.includes(oldRoundLimit)) {
        source = source.replace(oldRoundLimit, "for(;round<8;round+=1)");
      } else if (!source.includes("round<MAX_TOOL_ROUNDS")
        && !source.includes("for(;round<8;round+=1)")
        && !source.includes("for(;round<20;round+=1)")) {
        throw new Error(`${filePath}: local gateway tool round limit was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V13} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V14)) {
      const historyInitNeedle =
        'let input=this._localGatewayInput(e.prompt||[{type:"text",text:e.message||e.content||""}]),round=0;';
      const historyInitReplacement =
        'const promptParts=e.prompt||[{type:"text",text:e.message||e.content||""}],history={userText:this._localGatewayInput(promptParts).flatMap(item=>item.content||[]).map(part=>part.text||"").join("\\n"),assistantText:"",createdAt:Date.now(),title:metadata?.["ai-coding/task-title"]||metadata?.["ai-coding/title"],workspacePath};(this.__qoderBridgeHistory??=new Map).set(sessionId,history);let input=this._localGatewayInput(promptParts),round=0;';
      if (!source.includes("this.__qoderBridgeHistory")) {
        if (!source.includes(historyInitNeedle)) {
          throw new Error(`${filePath}: local gateway history initialization point was not found`);
        }
        source = source.replace(historyInitNeedle, historyInitReplacement);
      }
      const historyCatchNeedle =
        'catch(error){this.__qoderBridgeControllers?.delete(sessionId);return await this.handleRequestError("session/prompt",{sessionId,_meta:metadata},error,"request"),{}}\n}';
      const historyCatchReplacement =
        'catch(error){this.__qoderBridgeControllers?.delete(sessionId);await this._appendLocalGatewayHistory(sessionId,requestId,history,/cancel/i.test(String(error?.message||""))||error?.name==="AbortError"?"Cancelled":"Failed");return await this.handleRequestError("session/prompt",{sessionId,_meta:metadata},error,"request"),{}}\n}';
      if (source.includes(historyCatchNeedle)) {
        source = source.replace(historyCatchNeedle, historyCatchReplacement);
      } else if (!source.includes("_appendLocalGatewayHistory(sessionId,requestId,history")) {
        throw new Error(`${filePath}: local gateway history error path was not found`);
      }
      if (source.includes(LOCAL_GATEWAY_PROGRESS_V8)) {
        source = source.replace(
          LOCAL_GATEWAY_PROGRESS_V8,
          `${LOCAL_GATEWAY_PROGRESS_V14}${LOCAL_GATEWAY_HISTORY_METHOD}`
        );
      } else if (!source.includes(LOCAL_GATEWAY_PROGRESS_V14)
        || !source.includes(LOCAL_GATEWAY_HISTORY_METHOD)) {
        throw new Error(`${filePath}: local gateway progress persistence point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V14} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V15)) {
      const runtimeNeedle =
        'const sessionId=e.sessionId,metadata=e._meta||{},requestId=metadata?.[s.Constants.ACP_META_KEYS.REQUEST_ID]||"",customModel=metadata?.[s.Constants.ACP_META_KEYS.CUSTOM_MODEL],baseUrl=customModel?.parameters?.base_url?.replace(/\\/+$/,""),endpoint=baseUrl?baseUrl+"/responses":null,workspacePath=metadata?.["ai-coding/workspace-path"]||"";';
      const runtimeReplacement =
        'const sessionId=e.sessionId,metadata=e._meta||{},requestId=metadata?.[s.Constants.ACP_META_KEYS.REQUEST_ID]||"",runtimeConfig=metadata?.["ai-coding/model_config"]||{},customModel=metadata?.[s.Constants.ACP_META_KEYS.CUSTOM_MODEL],baseUrl=customModel?.parameters?.base_url?.replace(/\\/+$/,""),endpoint=baseUrl?baseUrl+"/responses":null,workspacePath=metadata?.["ai-coding/workspace-path"]||"",contextLength=Number.isInteger(runtimeConfig.max_input_tokens)&&runtimeConfig.max_input_tokens>0?runtimeConfig.max_input_tokens:Number.isInteger(customModel?.max_input_tokens)&&customModel.max_input_tokens>0?customModel.max_input_tokens:void 0,reasoningEffort=typeof runtimeConfig.reasoning_effort==="string"&&runtimeConfig.reasoning_effort?runtimeConfig.reasoning_effort:customModel?.is_reasoning===true?"medium":void 0;';
      if (source.includes(runtimeNeedle)) {
        source = source.replace(runtimeNeedle, runtimeReplacement);
      } else if (!source.includes('runtimeConfig=metadata?.["ai-coding/model_config"]||{}')) {
        throw new Error(`${filePath}: local gateway runtime config point was not found`);
      }
      const requestNeedle =
        'tool_choice:"auto",reasoning:customModel.is_reasoning===true?{effort:"medium"}:void 0,stream:!0,metadata:';
      const requestReplacement =
        'tool_choice:"auto",context_length:contextLength,reasoning:reasoningEffort?{effort:reasoningEffort}:void 0,stream:!0,metadata:';
      if (source.includes(requestNeedle)) {
        source = source.replace(requestNeedle, requestReplacement);
      } else if (!source.includes("context_length:contextLength")
        || !source.includes("reasoning:reasoningEffort?{effort:reasoningEffort}")) {
        throw new Error(`${filePath}: local gateway runtime request point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V15} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V16)) {
      const progressNeedle = LOCAL_GATEWAY_PROGRESS_V14;
      if (source.includes(progressNeedle)) {
        source = source.replace(progressNeedle, LOCAL_GATEWAY_PROGRESS_V16);
      } else if (!source.includes("_finishLocalGatewayPrompt")
        || !source.includes("terminalSent")) {
        throw new Error(`${filePath}: local gateway terminal state point was not found`);
      }
      const historyCatchNeedle =
        'catch(error){this.__qoderBridgeControllers?.delete(sessionId);await this._appendLocalGatewayHistory(sessionId,requestId,history,/cancel/i.test(String(error?.message||""))||error?.name==="AbortError"?"Cancelled":"Failed");return await this.handleRequestError("session/prompt",{sessionId,_meta:metadata},error,"request"),{}}\n}';
      const historyCatchReplacement =
        'catch(error){this.__qoderBridgeControllers?.delete(sessionId);const cancelled=/cancel/i.test(String(error?.message||""))||error?.name==="AbortError";await this.handleRequestError("session/prompt",{sessionId,_meta:metadata},error,"request");await this._appendLocalGatewayHistory(sessionId,requestId,history,cancelled?"Cancelled":"Failed");return{}}\n}';
      if (source.includes(historyCatchNeedle)) {
        source = source.replace(historyCatchNeedle, historyCatchReplacement);
      } else if (!source.includes('await this._appendLocalGatewayHistory(sessionId,requestId,history,cancelled?"Cancelled":"Failed")')) {
        throw new Error(`${filePath}: local gateway terminal error ordering point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V16} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V17)) {
      const malformedProgressBoundary =
        "if(done)await this._finishLocalGatewayPrompt(sessionId,requestId,state)}}async _appendLocalGatewayHistory";
      const fixedProgressBoundary =
        "if(done)await this._finishLocalGatewayPrompt(sessionId,requestId,state)}async _appendLocalGatewayHistory";
      if (source.includes(malformedProgressBoundary)) {
        source = source.replace(malformedProgressBoundary, fixedProgressBoundary);
      } else if (source.includes("_finishLocalGatewayPrompt")
        && !source.includes(fixedProgressBoundary)) {
        throw new Error(`${filePath}: local gateway V16 method boundary repair point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V17} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V18)) {
      const handlerPattern =
        /async _handleLocalGatewayPrompt\(e\)\{.*?\n\}(?=\n\n_localGatewayTools\(\))/s;
      if (!handlerPattern.test(source)) {
        throw new Error(`${filePath}: local gateway V18 handler replacement point was not found`);
      }
      source = source.replace(handlerPattern, LOCAL_GATEWAY_HANDLER_V12);
      source += `\n/* ${PATCH_MARKER_V18} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V19)) {
      const toolBlockReplacement =
        '_localGatewayTools(){return[{type:"function",name:"read_file",description:"Read a UTF-8 text file inside the current Qoder folder. Requires an opened workspace. Do not retry the same path if it fails. Read-only.",parameters:{type:"object",properties:{path:{type:"string",description:"Workspace-relative file path"}},required:["path"],additionalProperties:!1}},{type:"function",name:"list_files",description:"List entries inside the current Qoder folder. Requires an opened workspace. If the workspace is empty or missing, tell the user to open a folder; do not call list_files again with the same path. Read-only.",parameters:{type:"object",properties:{path:{type:"string",description:"Workspace-relative directory path, default ."}},additionalProperties:!1}},{type:"function",name:"search_text",description:"Search for text in one UTF-8 file inside the current Qoder folder. Requires an opened workspace. Read-only.",parameters:{type:"object",properties:{path:{type:"string",description:"Workspace-relative file path"},query:{type:"string",description:"Text to find"}},required:["path","query"],additionalProperties:!1}},{type:"function",name:"list_qoder_plugins",description:"List Qoder plugin bundles (skills, MCP, agents, commands) from the local plugin cache. Use this for plugin questions even when no workspace folder is open. Read-only.",parameters:{type:"object",properties:{query:{type:"string",description:"Optional search text"}},additionalProperties:!1}},{type:"function",name:"list_qoder_plugin_files",description:"List entries inside one Qoder plugin bundle. Read-only.",parameters:{type:"object",properties:{plugin:{type:"string",description:"Plugin name"},path:{type:"string",description:"Plugin-relative directory path, default ."}},required:["plugin"],additionalProperties:!1}},{type:"function",name:"read_qoder_plugin_file",description:"Read a UTF-8 text file from one Qoder plugin bundle. Read-only.",parameters:{type:"object",properties:{plugin:{type:"string",description:"Plugin name"},path:{type:"string",description:"Plugin-relative file path"}},required:["plugin","path"],additionalProperties:!1}},{type:"function",name:"search_qoder_plugins",description:"Search text inside Qoder plugin bundle metadata and docs. Read-only.",parameters:{type:"object",properties:{query:{type:"string",description:"Text to find"}},required:["query"],additionalProperties:!1}}]}';
      const toolBlockPattern =
        /_localGatewayTools\(\)\{[\s\S]*?\n\}\n\nasync _readLocalGatewayResponse/;
      if (toolBlockPattern.test(source)) {
        source = source.replace(
          toolBlockPattern,
          `${toolBlockReplacement}\n\nasync _readLocalGatewayResponse`
        );
      } else if (!source.includes("list_qoder_plugins")
        || !source.includes("read_qoder_plugin_file")
        || !source.includes("search_qoder_plugins")) {
        throw new Error(`${filePath}: local gateway tool list replacement point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V19} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V20)) {
      const brokenToolBoundary =
        'required:["query"],additionalProperties:!1}}]\n\nasync _readLocalGatewayResponse';
      const fixedToolBoundary =
        'required:["query"],additionalProperties:!1}}]}\n\nasync _readLocalGatewayResponse';
      if (source.includes(brokenToolBoundary)) {
        source = source.replace(brokenToolBoundary, fixedToolBoundary);
      } else if (source.includes("list_qoder_plugins")
        && !source.includes(fixedToolBoundary)) {
        throw new Error(`${filePath}: local gateway V20 tool method boundary repair point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V20} */\n`;
    }
    if (!source.includes(PATCH_MARKER_V22)) {
      const workspaceFolderNeedle =
        "t.getWorkspaceFolder=function(){let e=a.workspace.workspaceFolders;if(e&&e.length>0)return e[0].uri;return}";
      const workspaceFolderReplacement =
        't.getWorkspaceFolder=function(){let e=a.workspace.workspaceFolders;if(e&&e.length>0)return e[0].uri;const t=m()?.uri;if(t&&t!=="unknown")return t;try{return a.Uri.file(process.cwd&&process.cwd()!=="/"?process.cwd():process.env.HOME||"/")}catch(e){return a.Uri.file("/")}}';
      if (source.includes(workspaceFolderNeedle)) {
        source = source.replace(workspaceFolderNeedle, workspaceFolderReplacement);
      } else if (!source.includes('process.cwd&&process.cwd()!=="/"?process.cwd():process.env.HOME||"/"')) {
        throw new Error(`${filePath}: workspace folder fallback point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V22}: workspace folder fallback */\n`;
    }
    if (!source.includes(PATCH_MARKER_V23)) {
      const fallbackFolderNeedle =
        'function m(){return{index:0,uri:a.window.activeTextEditor?.document.uri||"unknown",name:"Untitled"}}';
      const fallbackFolderReplacement =
        'function m(){const e=a.window.activeTextEditor?.document.uri;if(e)return{index:0,uri:e,name:"Untitled"};let t="/";try{t=process.cwd&&process.cwd()!=="/"?process.cwd():process.env.HOME||"/"}catch(e){}return{index:0,uri:a.Uri.file(t),name:"Fallback"}}';
      if (source.includes(fallbackFolderNeedle)) {
        source = source.replace(fallbackFolderNeedle, fallbackFolderReplacement);
      } else if (!source.includes('name:"Fallback"')) {
        throw new Error(`${filePath}: current workspace folder fallback point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V23}: current workspace fallback uri */\n`;
    }
    if (!source.includes(PATCH_MARKER_V24)) {
      const initializeNeedle =
        'let e=new h.InitializeParamsWithConfig,t=(0,O.getCurrentWorkspaceFolder)();e.workspaceFolders=t.map(e=>({name:e.name,uri:e.uri.fsPath})),I.CosyUtils.configIdeProps(e),this.initializeParams=e';
      const initializeReplacement =
        'let e=new h.InitializeParamsWithConfig,t=(0,O.getCurrentWorkspaceFolder)();e.rootUri=t[0]?.uri?.toString(),e.rootPath=t[0]?.uri?.fsPath,e.workspaceFolders=t.map(e=>({name:e.name,uri:e.uri.toString()})),I.CosyUtils.configIdeProps(e),this.initializeParams=e';
      if (source.includes(initializeNeedle)) {
        source = source.replace(initializeNeedle, initializeReplacement);
      } else if (!source.includes('uri:e.uri.toString()')) {
        throw new Error(`${filePath}: initialize workspace uri patch point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V24}: initialize workspace uri fallback */\n`;
    }
    if (!source.includes(PATCH_MARKER_V25)) {
      const conflictingInitializePatch =
        'let e=new h.InitializeParamsWithConfig,t=(0,O.getCurrentWorkspaceFolder)(),r=t[0]?.uri?.toString();e.rootUri=r,e.rootPath=t[0]?.uri?.fsPath,e.workspaceFolders=t.map(e=>({name:e.name,uri:e.uri.toString()})),I.CosyUtils.configIdeProps(e),this.initializeParams=e';
      const fixedInitializePatch =
        'let e=new h.InitializeParamsWithConfig,t=(0,O.getCurrentWorkspaceFolder)();e.rootUri=t[0]?.uri?.toString(),e.rootPath=t[0]?.uri?.fsPath,e.workspaceFolders=t.map(e=>({name:e.name,uri:e.uri.toString()})),I.CosyUtils.configIdeProps(e),this.initializeParams=e';
      if (source.includes(conflictingInitializePatch)) {
        source = source.replace(conflictingInitializePatch, fixedInitializePatch);
      } else if (!source.includes('e.rootUri=t[0]?.uri?.toString()')) {
        throw new Error(`${filePath}: initialize workspace URI conflict repair point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V25}: initialize workspace URI conflict repaired */\n`;
    }
    if (!source.includes(PATCH_MARKER_V26)) {
      const initializeSetterPatch =
        'let e=new h.InitializeParamsWithConfig,t=(0,O.getCurrentWorkspaceFolder)();e.rootUri=t[0]?.uri?.toString(),e.rootPath=t[0]?.uri?.fsPath,e.workspaceFolders=t.map(e=>({name:e.name,uri:e.uri.toString()})),I.CosyUtils.configIdeProps(e),this.initializeParams=e';
      const initializeEnumerablePatch =
        'let e=new h.InitializeParamsWithConfig,t=(0,O.getCurrentWorkspaceFolder)();Object.defineProperty(e,"rootUri",{value:t[0]?.uri?.toString(),enumerable:!0,configurable:!0,writable:!0}),e.rootPath=t[0]?.uri?.fsPath,e.workspaceFolders=t.map(e=>({name:e.name,uri:e.uri.toString()})),I.CosyUtils.configIdeProps(e),this.initializeParams=e';
      if (source.includes(initializeSetterPatch)) {
        source = source.replace(initializeSetterPatch, initializeEnumerablePatch);
      } else if (!source.includes('Object.defineProperty(e,"rootUri"')) {
        throw new Error(`${filePath}: initialize enumerable rootUri patch point was not found`);
      }
      source += `\n/* ${PATCH_MARKER_V26}: initialize enumerable rootUri */\n`;
    }
    if (
      !source.includes(PATCH_MARKER_V27)
      || source.includes("Stopped a repeated local tool call")
      || source.includes("Stopped the local tool loop after")
    ) {
      const abortNeedle =
        'if(seenCount>MAX_DUPLICATE_TOOL_CALLS){await this._emitLocalGatewayToolProgress(sessionId,requestId,call,"failed","repeated local tool call stopped");this.__qoderBridgeControllers?.delete(sessionId);await this._emitLocalGatewayProgress(sessionId,requestId,"\\n\\n[Qoder Bridge] Stopped a repeated local tool call ("+call.name+"). Please use the previous result or change the path/query before calling again.",!0);return{}}\nconst result=await this._executeLocalGatewayTool(baseUrl,workspacePath,requestId,call,controller.signal);\nensureActive();\nawait this._emitLocalGatewayToolProgress(sessionId,requestId,call,result.ok?"completed":"failed",result.output);';
      const reuseReplacement =
        'let result;\nif(seenCount>MAX_DUPLICATE_TOOL_CALLS&&toolResults.has(signature)){\nconst previous=toolResults.get(signature);\nresult={ok:previous.ok,output:"repeated tool call reused previous result; change path/query if you need new data\\n"+previous.output};\nawait this._emitLocalGatewayToolProgress(sessionId,requestId,call,previous.ok?"completed":"failed",result.output);\n}else{\nresult=await this._executeLocalGatewayTool(baseUrl,workspacePath,requestId,call,controller.signal);\nensureActive();\ntoolResults.set(signature,result);\nawait this._emitLocalGatewayToolProgress(sessionId,requestId,call,result.ok?"completed":"failed",result.output);\n}';
      if (source.includes(abortNeedle)) {
        source = source.replaceAll(abortNeedle, reuseReplacement);
      } else if (source.includes("Stopped a repeated local tool call")) {
        throw new Error(`${filePath}: local gateway duplicate tool reuse point was not found`);
      } else if (!source.includes("repeated tool call reused previous result")
        || !source.includes("toolResults=new Map")) {
        throw new Error(`${filePath}: local gateway duplicate tool reuse point was not found`);
      }
      if (source.includes("const seenToolCalls=new Map,MAX_TOOL_ROUNDS=8")
        && !source.includes("toolResults=new Map")) {
        source = source.replaceAll(
          "const seenToolCalls=new Map,MAX_TOOL_ROUNDS=8",
          "const seenToolCalls=new Map,toolResults=new Map,MAX_TOOL_ROUNDS=8"
        );
      }
      if (!source.includes("const finishPrompt=(text=\"\")=>this._emitLocalGatewayProgress(sessionId,requestId,text,!0);")
        && source.includes("const seenToolCalls=new Map,toolResults=new Map,MAX_TOOL_ROUNDS=8")) {
        source = source.replace(
          "const seenToolCalls=new Map,toolResults=new Map,MAX_TOOL_ROUNDS=8,MAX_TOOL_CALLS=24,MAX_DUPLICATE_TOOL_CALLS=2,ensureActive=()=>{if(controller.signal.aborted)throw new Error(\"session cancelled\")};",
          "const seenToolCalls=new Map,toolResults=new Map,MAX_TOOL_ROUNDS=8,MAX_TOOL_CALLS=24,MAX_DUPLICATE_TOOL_CALLS=2,ensureActive=()=>{if(controller.signal.aborted)throw new Error(\"session cancelled\")};\nconst finishPrompt=(text=\"\")=>this._emitLocalGatewayProgress(sessionId,requestId,text,!0);\nconst failPrompt=async(text)=>{const state=this.__qoderBridgeHistory?.get(sessionId);this.__qoderBridgeControllers?.delete(sessionId);if(text)await this._emitLocalGatewayProgress(sessionId,requestId,text);await this._finishLocalGatewayPrompt(sessionId,requestId,state,\"failed\",500,\"end_turn\")};"
        );
      }
      const catchNeedle =
        'catch(error){this.__qoderBridgeControllers?.delete(sessionId);const cancelled=/cancel/i.test(String(error?.message||""))||error?.name==="AbortError";await this.handleRequestError("session/prompt",{sessionId,_meta:metadata},error,"request");await this._appendLocalGatewayHistory(sessionId,requestId,history,cancelled?"Cancelled":"Failed");return{}}';
      const catchReplacement =
        'catch(error){const cancelled=/cancel/i.test(String(error?.message||""))||error?.name==="AbortError";this.__qoderBridgeControllers?.delete(sessionId);if(cancelled){const state=this.__qoderBridgeHistory?.get(sessionId);await this._finishLocalGatewayPrompt(sessionId,requestId,state,"cancelled",499,"cancelled");return{}}await failPrompt("\\n\\n[Qoder Bridge] "+String(error?.message||error).slice(0,400));return{}}';
      if (source.includes(catchNeedle)) {
        source = source.replaceAll(catchNeedle, catchReplacement);
      } else if (!source.includes("await failPrompt(")) {
        throw new Error(`${filePath}: local gateway tool error terminal point was not found`);
      }
      const limitNeedle =
        'if(totalToolCalls>MAX_TOOL_CALLS){await this._emitLocalGatewayToolProgress(sessionId,requestId,call,"failed","local gateway total tool call limit exceeded");this.__qoderBridgeControllers?.delete(sessionId);await this._emitLocalGatewayProgress(sessionId,requestId,"\\n\\n[Qoder Bridge] Stopped the local tool loop after "+MAX_TOOL_CALLS+" tool calls. Please narrow the request or summarize from the tool results already returned.",!0);return{}}';
      const limitNeedleV27 =
        'if(totalToolCalls>MAX_TOOL_CALLS){await this._emitLocalGatewayToolProgress(sessionId,requestId,call,"failed","local gateway total tool call limit exceeded");this.__qoderBridgeControllers?.delete(sessionId);await finishPrompt("\\n\\n[Qoder Bridge] Stopped the local tool loop after "+MAX_TOOL_CALLS+" tool calls. Please narrow the request or summarize from the tool results already returned.");return{}}';
      const limitReplacement =
        'if(totalToolCalls>MAX_TOOL_CALLS){const output="tool loop limit reached after "+MAX_TOOL_CALLS+" calls; summarize from previous tool results and stop calling tools";await this._emitLocalGatewayToolProgress(sessionId,requestId,call,"failed",output);functionInputs.push({type:"function_call",id:call.id,call_id:call.call_id,name:call.name,arguments:call.arguments});functionOutputs.push({type:"function_call_output",call_id:call.call_id,output:output});input=input.concat(functionInputs,functionOutputs);break}';
      if (source.includes(limitNeedle)) {
        source = source.replaceAll(limitNeedle, limitReplacement);
      } else if (source.includes(limitNeedleV27)) {
        source = source.replaceAll(limitNeedleV27, limitReplacement);
      } else if (!source.includes("tool loop limit reached after")) {
        throw new Error(`${filePath}: local gateway tool loop limit point was not found`);
      }
      if (!source.includes(PATCH_MARKER_V27)) {
        source += `\n/* ${PATCH_MARKER_V27}: reuse duplicate tools and finish errors without system exception */\n`;
      }
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
      source.includes(PATCH_MARKER_V13)
        && source.includes("_localGatewayTools")
        && source.includes("_executeLocalGatewayTool")
        && source.includes("function_call_output")
        && source.includes("tool_call_update")
        && source.includes("MAX_TOOL_ROUNDS=8")
        && source.includes("MAX_TOOL_CALLS=24")
        && source.includes("MAX_DUPLICATE_TOOL_CALLS=2")
        && source.includes("_localGatewayToolSignature")
        && source.includes("_compactLocalGatewayToolOutput")
    ]);
    checks.push([
      "Qoder plugin tools",
      source.includes(PATCH_MARKER_V19)
        && source.includes(PATCH_MARKER_V20)
        && source.includes("list_qoder_plugins")
        && source.includes("list_qoder_plugin_files")
        && source.includes("read_qoder_plugin_file")
        && source.includes("search_qoder_plugins")
        && !source.includes('required:["query"],additionalProperties:!1}}]\n\nasync _readLocalGatewayResponse')
    ]);
    checks.push([
      "Qoder workspace folder fallback",
      source.includes(PATCH_MARKER_V22)
        && source.includes('process.cwd&&process.cwd()!=="/"?process.cwd():process.env.HOME||"/"')
    ]);
    checks.push([
      "Qoder current workspace fallback uri",
      source.includes(PATCH_MARKER_V23)
        && source.includes('name:"Fallback"')
        && source.includes('function m(){const e=a.window.activeTextEditor?.document.uri;if(e)return{index:0,uri:e,name:"Untitled"}')
    ]);
    checks.push([
      "Qoder initialize workspace URI fallback",
      source.includes(PATCH_MARKER_V24)
        && (
          source.includes('e.rootUri=t[0]?.uri?.toString()')
          || source.includes('Object.defineProperty(e,"rootUri"')
        )
        && source.includes('e.rootPath=t[0]?.uri?.fsPath')
        && source.includes('uri:e.uri.toString()')
    ]);
    checks.push([
      "Qoder initialize workspace URI conflict repair",
      source.includes(PATCH_MARKER_V25)
        && !source.includes('),r=t[0]?.uri?.toString();e.rootUri=r')
        && (
          source.includes('e.rootUri=t[0]?.uri?.toString()')
          || source.includes('Object.defineProperty(e,"rootUri"')
        )
    ]);
    checks.push([
      "Qoder initialize enumerable rootUri",
      source.includes(PATCH_MARKER_V26)
        && source.includes('Object.defineProperty(e,"rootUri"')
        && source.includes('enumerable:!0')
        && source.includes('uri:e.uri.toString()')
    ]);
    checks.push([
      "Qoder reasoning separation",
      source.includes("_emitLocalGatewayReasoningProgress")
        && source.includes('sessionUpdate:"agent_thought_chunk"')
    ]);
    checks.push([
      "Qoder history persistence",
      source.includes(PATCH_MARKER_V14)
        && source.includes("_appendLocalGatewayHistory")
        && source.includes("session/appendHistoryTurn")
        && source.includes("assistantText")
        && source.includes("contentType:\"markdown\"")
    ]);
    checks.push([
      "Qoder runtime model controls",
      source.includes(PATCH_MARKER_V15)
        && source.includes('runtimeConfig=metadata?.["ai-coding/model_config"]||{}')
        && source.includes("context_length:contextLength")
        && source.includes("reasoning:reasoningEffort?{effort:reasoningEffort}")
    ]);
    checks.push([
      "Qoder terminal state ordering",
      source.includes(PATCH_MARKER_V16)
        && source.includes(PATCH_MARKER_V17)
        && source.includes(PATCH_MARKER_V18)
        && source.includes("_finishLocalGatewayPrompt")
        && source.includes("terminalSent")
        && !source.includes("state)}}async _appendLocalGatewayHistory")
        && source.includes("await this._appendLocalGatewayHistory(sessionId,requestId,state")
        && (
          source.includes('await this.handleRequestError("session/prompt",{sessionId,_meta:metadata},error,"request");await this._appendLocalGatewayHistory')
          || source.includes("await failPrompt(")
        )
    ]);
    checks.push([
      "Qoder duplicate tool reuse",
      source.includes(PATCH_MARKER_V27)
        && source.includes("toolResults=new Map")
        && source.includes("repeated tool call reused previous result")
        && source.includes("await failPrompt(")
        && source.includes("tool loop limit reached after")
        && !source.includes("if(seenCount>MAX_DUPLICATE_TOOL_CALLS){await this._emitLocalGatewayToolProgress(sessionId,requestId,call,\"failed\",\"repeated local tool call stopped\")")
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
  const models = Array.isArray(options.models) && options.models.length
    ? options.models
    : await discoverModels(gatewayUrl, options.authorization);
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
