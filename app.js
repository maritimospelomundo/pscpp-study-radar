import Dexie from "dexie";
import { Rating, createEmptyCard, fsrs } from "ts-fsrs";

const PASSWORD_HASH="ea197173a22ff3031e920007f63d59a5e324a02db220109f82cec16a69195cfe";
const AUTH_KEY="pscpp-study-radar-auth";
const API_TOKEN_KEY="pscpp-study-radar-api-token";
const DEVICE_ID_KEY="pscpp-study-radar-device-id";
const STORAGE_KEY="pscpp-study-radar-v3";
const LEGACY_STORAGE_KEYS=["pscpp-study-radar-v2","pscpp-study-radar-v1"];
const scheduler=fsrs({enable_fuzz:false,enable_short_term:false});
const database=new Dexie("pscpp-study-radar");
database.version(1).stores({settings:"key",attempts:"questionId,answeredAt,nextReview,mastery"});
const letter=i=>String.fromCharCode(97+i);
const escapeHtml=value=>String(value).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
let round,syllabus,bibliography,currentIndex=0,questionShownAt=Date.now();
let state={attempts:{},startedAt:new Date().toISOString(),mode:"study",simulationSelections:{},simulationSubmitted:false,roundId:null};
let apiConfig={enabled:false,apiBase:""},syncState="local",syncTimer;

async function sha256(value){const bytes=new TextEncoder().encode(value),digest=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("")}
async function loadApiConfig(){try{const response=await fetch("data/config.json",{cache:"no-store"});if(response.ok)apiConfig={...apiConfig,...await response.json()}}catch{apiConfig={enabled:false,apiBase:""}}}
function apiUrl(path){return `${String(apiConfig.apiBase||"").replace(/\/$/,"")}${path}`}
function apiToken(){return localStorage.getItem(API_TOKEN_KEY)}
function deviceId(){let id=localStorage.getItem(DEVICE_ID_KEY);if(!id){id=crypto.randomUUID();localStorage.setItem(DEVICE_ID_KEY,id)}return id}
async function remoteLogin(password){
  if(!apiConfig.enabled||!apiConfig.apiBase)return true;
  try{const response=await fetch(apiUrl("/api/session"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password})});if(!response.ok)throw new Error("login remoto recusado");const data=await response.json();localStorage.setItem(API_TOKEN_KEY,data.token);syncState="ready";return true}catch(error){console.warn("Sincronização indisponível; o modo offline continua ativo.",error);syncState="pending";return false}
}
async function boot(){
  await loadApiConfig();
  const form=document.getElementById("login-form"),input=document.getElementById("access-password"),error=document.getElementById("login-error");
  const unlock=async()=>{document.body.classList.remove("locked");document.getElementById("login-screen").hidden=true;await init()};
  if(sessionStorage.getItem(AUTH_KEY)==="granted"&&(!apiConfig.enabled||apiToken())){await unlock();return}
  form.addEventListener("submit",async event=>{event.preventDefault();error.hidden=true;const password=input.value,hash=await sha256(password);if(hash===PASSWORD_HASH){sessionStorage.setItem(AUTH_KEY,"granted");await remoteLogin(password);input.value="";await unlock()}else{error.hidden=false;input.select()}});
}

async function loadState(){
  try{
    const rows=await database.table("attempts").toArray();
    const meta=await database.table("settings").get("session");
    if(rows.length)return{...state,attempts:Object.fromEntries(rows.map(row=>[row.questionId,row])),startedAt:meta?.startedAt||new Date().toISOString(),mode:meta?.mode||"study",simulationSelections:meta?.simulationSelections||{},simulationSubmitted:Boolean(meta?.simulationSubmitted),roundId:meta?.roundId||null};
  }catch(error){console.warn("IndexedDB indisponível; usando armazenamento local.",error)}
  try{const saved=localStorage.getItem(STORAGE_KEY)||LEGACY_STORAGE_KEYS.map(key=>localStorage.getItem(key)).find(Boolean);return{...state,...(JSON.parse(saved)||{})}}catch{return state}
}
async function saveState(questionId){
  const updatedAt=new Date().toISOString();
  if(questionId&&state.attempts[questionId])state.attempts[questionId].updatedAt=updatedAt;
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
  try{
    await database.table("settings").put({key:"session",startedAt:state.startedAt,updatedAt,mode:state.mode,simulationSelections:state.simulationSelections,simulationSubmitted:state.simulationSubmitted,roundId:state.roundId});
    if(questionId)await database.table("attempts").put({...state.attempts[questionId],questionId});
    else await database.table("attempts").bulkPut(Object.entries(state.attempts).map(([id,attempt])=>({...attempt,questionId:id})));
  }catch(error){console.warn("Falha ao salvar no IndexedDB; cópia local preservada.",error)}
  queueSync();
}
function attemptFor(id){return state.attempts[id]}

function mergeCloudAttempts(rows=[]){
  let changed=false;
  rows.forEach(row=>{if(!row?.questionId||!row.payload)return;const local=state.attempts[row.questionId],remoteDate=new Date(row.payload.updatedAt||row.updatedAt||0),localDate=new Date(local?.updatedAt||local?.answeredAt||0);if(!local||remoteDate>localDate){state.attempts[row.questionId]=row.payload;changed=true}});
  return changed;
}
async function pullCloudState(){
  if(!apiConfig.enabled||!apiToken())return;
  try{const response=await fetch(apiUrl("/api/state"),{headers:{Authorization:`Bearer ${apiToken()}`}});if(response.status===401){localStorage.removeItem(API_TOKEN_KEY);syncState="auth";return}if(!response.ok)throw new Error("leitura remota falhou");const data=await response.json();if(mergeCloudAttempts(data.attempts)){localStorage.setItem(STORAGE_KEY,JSON.stringify(state));await database.table("attempts").bulkPut(Object.entries(state.attempts).map(([id,attempt])=>({...attempt,questionId:id})))}syncState="synced"}catch(error){console.warn("Histórico remoto temporariamente indisponível.",error);syncState="pending"}
}
function queueSync(){if(!round||!apiConfig.enabled||!apiToken())return;clearTimeout(syncTimer);syncTimer=setTimeout(performSync,900)}
async function performSync(){
  const token=apiToken();if(!token||!round)return;syncState="syncing";updateConnectionStatus();
  const rawAttempts=Object.fromEntries(round.questions.filter(q=>attemptFor(q.id)).map(q=>[q.id,attemptFor(q.id)]));
  try{const response=await fetch(apiUrl("/api/sync"),{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({deviceId:deviceId(),report:buildReport(),rawAttempts})});if(response.status===401){localStorage.removeItem(API_TOKEN_KEY);syncState="auth";throw new Error("sessão remota expirada")}if(!response.ok)throw new Error(`sincronização falhou (${response.status})`);syncState="synced"}catch(error){console.warn("A cópia local foi preservada para nova tentativa.",error);if(syncState!=="auth")syncState="pending"}updateConnectionStatus()
}

async function init(){
  state=await loadState();
  try{[round,syllabus,bibliography]=await Promise.all([fetch("data/questions.json").then(r=>{if(!r.ok)throw new Error();return r.json()}),fetch("data/syllabus.json").then(r=>{if(!r.ok)throw new Error();return r.json()}),fetch("data/bibliography.json").then(r=>{if(!r.ok)throw new Error();return r.json()})])}
  catch{document.querySelector("main").innerHTML='<div class="empty">Não foi possível carregar os dados da rodada. Atualize a página.</div>';return}
  await pullCloudState();
  if(state.roundId!==round.roundId){state.roundId=round.roundId;state.mode="study";state.simulationSelections={};state.simulationSubmitted=false;await saveState()}
  document.getElementById("today-label").textContent=new Intl.DateTimeFormat("pt-BR",{dateStyle:"long"}).format(new Date());
  document.querySelector(".context-strip div:nth-child(1) strong").textContent=round.label||"Intercalada";
  document.querySelector(".context-strip div:nth-child(2) strong").textContent=round.path||round.title;
  document.querySelector(".context-strip div:nth-child(3) strong").textContent=round.method||"4–3–2–1";
  populateLibraryFilters();
  updateConnectionStatus();
  window.addEventListener("online",updateConnectionStatus);window.addEventListener("offline",updateConnectionStatus);
  bindTabs();bindActions();renderAll();queueSync();
}

function updateConnectionStatus(){
  const online=navigator.onLine,labels={synced:"Online · sincronizado",syncing:"Online · sincronizando…",pending:"Online · sincronização pendente",auth:"Online · novo login para sincronizar",ready:"Online · nuvem conectada",local:"Online · dados locais ativos"};
  document.getElementById("connection-status").textContent=online?(apiConfig.enabled?labels[syncState]||labels.local:labels.local):"Offline · respostas preservadas";document.getElementById("connection-dot").classList.toggle("offline",!online||syncState==="pending"||syncState==="auth")
}

function bindTabs(){document.querySelectorAll(".tab").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(b=>{b.classList.toggle("active",b===button);b.setAttribute("aria-selected",b===button)});document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));document.getElementById(`view-${button.dataset.view}`).classList.add("active");if(button.dataset.view==="performance")renderPerformance()}))}
function bindActions(){
  document.getElementById("submit-answer").addEventListener("click",submitAnswer);
  document.getElementById("previous-question").addEventListener("click",()=>showQuestion(Math.max(0,currentIndex-1)));
  document.getElementById("next-question").addEventListener("click",()=>showQuestion(Math.min(round.questions.length-1,currentIndex+1)));
  document.getElementById("copy-report").addEventListener("click",async e=>{await navigator.clipboard.writeText(JSON.stringify(buildReport(),null,2));e.currentTarget.textContent="Copiado";setTimeout(()=>e.currentTarget.textContent="Copiar",1200)});
  document.getElementById("download-report").addEventListener("click",downloadReport);
  document.getElementById("logout-button").addEventListener("click",()=>{sessionStorage.removeItem(AUTH_KEY);localStorage.removeItem(API_TOKEN_KEY);location.reload()});
  document.querySelectorAll("[data-mode]").forEach(button=>button.addEventListener("click",()=>setMode(button.dataset.mode)));
  ["library-search","library-axis","library-priority"].forEach(id=>document.getElementById(id).addEventListener("input",renderLibrary));
}
function currentQuestions(){return new Set(round.questions.map(q=>q.id))}
function roundAttempts(){const ids=currentQuestions();return Object.entries(state.attempts).filter(([id])=>ids.has(id)).map(([,attempt])=>attempt)}
function canChangeMode(){return roundAttempts().length===0&&Object.keys(state.simulationSelections||{}).length===0&&!state.simulationSubmitted}
function setMode(mode){if(!canChangeMode()||!['study','simulation'].includes(mode))return;state.mode=mode;saveState();renderAll()}
function renderMode(){
  document.querySelectorAll("[data-mode]").forEach(button=>{const active=button.dataset.mode===state.mode;button.classList.toggle("active",active);button.setAttribute("aria-pressed",active);button.disabled=!canChangeMode()&&!active});
  document.getElementById("mode-description").textContent=state.mode==="study"?"Correção e comentário aparecem logo após cada resposta.":state.simulationSubmitted?"Simulado concluído: correções e referências liberadas.":"A correção fica oculta até você finalizar as 10 questões.";
}
function renderMix(){
  const labels={review:"Revisões FSRS",current:"Tema principal",rotation:"Matérias alternadas",official:"Questão oficial"};
  const counts=round.questions.reduce((acc,q)=>(acc[q.category]=(acc[q.category]||0)+1,acc),{});
  document.getElementById("mix-summary").innerHTML=Object.entries(labels).map(([key,label])=>`<span class="mix-chip ${key}"><strong>${counts[key]||0}</strong>${label}</span>`).join("");
}
function renderAll(){renderMode();renderMix();renderIndex();showQuestion(currentIndex);renderReviews();renderSyllabus();renderLibrary();renderPerformance();updateSummary();renderSimulationSummary()}

function renderIndex(){
  const container=document.getElementById("question-index");
  container.innerHTML=round.questions.map((q,i)=>{const a=attemptFor(q.id),saved=state.mode==="simulation"&&!state.simulationSubmitted&&state.simulationSelections?.[q.id],status=a?(a.correct?"right":"wrong"):(saved?"saved":"");return`<button class="index-button ${status} ${i===currentIndex?"current":""}" data-index="${i}" aria-label="Questão ${i+1}">${i+1}</button>`}).join("");
  container.querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>showQuestion(Number(b.dataset.index))));
}
function showQuestion(index){
  currentIndex=index;questionShownAt=Date.now();const q=round.questions[index],attempt=attemptFor(q.id),simulationOpen=state.mode==="simulation"&&!state.simulationSubmitted,simulationSelection=state.simulationSelections?.[q.id];
  document.getElementById("question-kind").textContent=`${q.kind} · Eixo ${q.axis}`;document.getElementById("question-number").textContent=`${index+1} de ${round.questions.length}`;document.getElementById("question-source").textContent=`Referência-base: ${q.reference.base||q.reference.publication}`;document.getElementById("question-stem").textContent=q.stem;
  const form=document.getElementById("answers");
  form.innerHTML=q.options.map((option,i)=>{const selected=(simulationOpen?simulationSelection?.selected:attempt?.selected)===i,className=attempt?(i===q.correct?"correct":(selected?"incorrect":"")):"";return`<label class="answer ${className}"><input type="radio" name="answer" value="${i}" ${selected?"checked":""} ${attempt?"disabled":""}><strong>${letter(i)})</strong><span>${escapeHtml(option)}</span></label>`}).join("");
  const submit=document.getElementById("submit-answer"),allSimulationAnswered=round.questions.every(item=>state.simulationSelections?.[item.id]);submit.hidden=Boolean(attempt);submit.disabled=!simulationSelection;submit.textContent=state.mode==="simulation"&&!state.simulationSubmitted?(allSimulationAnswered?"Finalizar simulado":simulationSelection?"Atualizar e avançar":"Salvar e avançar"):"Confirmar resposta";form.querySelectorAll("input").forEach(input=>input.addEventListener("change",()=>submit.disabled=false));renderFeedback(q,attempt);document.getElementById("previous-question").disabled=index===0;document.getElementById("next-question").disabled=index===round.questions.length-1;renderIndex();
}
function submitAnswer(){
  const q=round.questions[currentIndex],chosen=document.querySelector('input[name="answer"]:checked');if(!chosen)return;const selected=Number(chosen.value);
  if(state.mode==="simulation"&&!state.simulationSubmitted){
    const previous=state.simulationSelections?.[q.id];state.simulationSelections[q.id]={selected,responseTimeSeconds:previous?.responseTimeSeconds||elapsedSeconds()};saveState();
    if(round.questions.every(item=>state.simulationSelections[item.id])){showQuestion(currentIndex);return}
    const next=round.questions.findIndex((item,i)=>i>currentIndex&&!state.simulationSelections[item.id]);showQuestion(next>=0?next:currentIndex);updateSummary();return;
  }
  const correct=selected===q.correct;
  const answeredAt=new Date();
  const base={selected,correct,mastery:correct?null:0,answeredAt:answeredAt.toISOString(),responseTimeSeconds:elapsedSeconds(),mode:"study",fsrsCard:createEmptyCard(answeredAt)};
  state.attempts[q.id]=correct?{...base,nextReview:null}:{...base,...scheduleCard(base.fsrsCard,Rating.Again,answeredAt)};
  saveState(q.id);renderAll();showQuestion(currentIndex);
}
function elapsedSeconds(){return Math.max(1,Math.round((Date.now()-questionShownAt)/1000))}
function finalizeSimulation(){
  const answeredAt=new Date();
  round.questions.forEach(q=>{const selection=state.simulationSelections[q.id],correct=selection.selected===q.correct,base={selected:selection.selected,correct,mastery:correct?null:0,answeredAt:answeredAt.toISOString(),updatedAt:answeredAt.toISOString(),responseTimeSeconds:selection.responseTimeSeconds,mode:"simulation",fsrsCard:createEmptyCard(answeredAt)};state.attempts[q.id]=correct?{...base,nextReview:null}:{...base,...scheduleCard(base.fsrsCard,Rating.Again,answeredAt)}});
  state.simulationSubmitted=true;saveState();renderAll();showQuestion(currentIndex);
}
function renderFeedback(q,attempt){
  const box=document.getElementById("feedback");if(!attempt){box.hidden=true;box.innerHTML="";return}box.hidden=false;
  const catalog=q.reference.referenceId?bibliography.references.find(item=>item.id===q.reference.referenceId):null;
  box.innerHTML=`<h3 class="${attempt.correct?"result-right":"result-wrong"}">${attempt.correct?"Resposta correta":`Resposta incorreta · correta: ${letter(q.correct)})`}</h3><p>${escapeHtml(q.explanation)}</p><div class="option-analysis">${q.comments.map((c,i)=>`<p><strong>${letter(i)})</strong> ${escapeHtml(c)}</p>`).join("")}</div><div class="reference-box"><div class="validation-stamp">✓ Fonte validada${q.reference.referenceId?` · ${escapeHtml(q.reference.referenceId)}`:""}</div><strong>${escapeHtml(q.reference.publication)}</strong><span>${escapeHtml(q.reference.edition)}</span><span>${escapeHtml(q.reference.section)}</span><span>${escapeHtml(q.reference.syllabus)}</span>${q.reference.evidence?`<span><strong>Evidência:</strong> ${escapeHtml(q.reference.evidence)}</span>`:""}${catalog?`<span><strong>Recorte oficial:</strong> ${escapeHtml(catalog.scope)}</span>`:""}${q.reference.origin?`<span>${escapeHtml(q.reference.origin)}</span>`:""}${q.reference.url?`<a href="${escapeHtml(q.reference.url)}" target="_blank" rel="noopener noreferrer">Abrir fonte oficial</a>`:""}</div>${attempt.correct?masteryMarkup(attempt.mastery):errorCauseMarkup(attempt.errorCause)}`;
  box.querySelectorAll("[data-mastery]").forEach(button=>button.addEventListener("click",()=>setMastery(q.id,Number(button.dataset.mastery))));
  box.querySelectorAll("[data-error-cause]").forEach(button=>button.addEventListener("click",()=>setErrorCause(q.id,button.dataset.errorCause)));
}
function masteryMarkup(current){const labels=["1 · Difícil","2 · Com esforço","3 · Fácil"];return`<div class="mastery"><p>Como você chegou à resposta correta?</p><div class="mastery-buttons">${labels.map((label,i)=>`<button data-mastery="${i+1}" class="${current===i+1?"selected":""}">${label}</button>`).join("")}</div></div>`}
function errorCauseMarkup(current){const causes=[["content","Faltou conteúdo"],["confusion","Confundi conceitos"],["reading","Leitura desatenta"],["guess","Chute"]];return`<div class="mastery"><p><strong>Domínio 0 — errou.</strong> O que mais contribuiu?</p><div class="mastery-buttons error-buttons">${causes.map(([value,label])=>`<button data-error-cause="${value}" class="${current===value?"selected":""}">${label}</button>`).join("")}</div></div>`}
function reviveCard(card){return{...card,due:new Date(card.due),last_review:card.last_review?new Date(card.last_review):undefined}}
function scheduleCard(card,rating,now=new Date()){const result=scheduler.next(reviveCard(card),now,rating);return{fsrsCard:result.card,fsrsLog:result.log,nextReview:new Date(result.card.due).toISOString()}}
function setMastery(id,mastery){const attempt=state.attempts[id],rating={1:Rating.Hard,2:Rating.Good,3:Rating.Easy}[mastery];Object.assign(attempt,{mastery,...scheduleCard(attempt.fsrsCard,rating,new Date(attempt.answeredAt))});saveState(id);renderAll();showQuestion(currentIndex)}
function setErrorCause(id,errorCause){state.attempts[id].errorCause=errorCause;saveState(id);renderAll();showQuestion(currentIndex)}
function dueAttempts(){const now=Date.now();return round.questions.filter(q=>{const a=attemptFor(q.id);return a?.nextReview&&new Date(a.nextReview).getTime()<=now})}
function updateSummary(){const attempts=roundAttempts(),simulationCount=Object.keys(state.simulationSelections||{}).length,answered=state.mode==="simulation"&&!state.simulationSubmitted?simulationCount:attempts.length,correct=attempts.filter(a=>a.correct).length;document.getElementById("round-score").textContent=`${answered}/${round.questions.length} respondidas`;document.getElementById("correct-counter").textContent=state.mode==="simulation"&&!state.simulationSubmitted?`${simulationCount} salvas`:`${correct} ${correct===1?"acerto":"acertos"}`;document.getElementById("review-badge").textContent=dueAttempts().length;const submit=document.getElementById("submit-answer");if(state.mode==="simulation"&&!state.simulationSubmitted&&round.questions.every(item=>state.simulationSelections?.[item.id])){submit.disabled=false;submit.onclick=finalizeSimulation}else submit.onclick=null}
function renderSimulationSummary(){const box=document.getElementById("simulation-summary");if(state.mode!=="simulation"||!state.simulationSubmitted){box.hidden=true;return}const attempts=roundAttempts(),correct=attempts.filter(a=>a.correct).length;box.hidden=false;box.innerHTML=`<strong>Simulado concluído: ${correct}/${round.questions.length}</strong><span>As correções foram liberadas. Revise os erros e classifique o esforço nas respostas corretas.</span>`}

function renderReviews(){
  const container=document.getElementById("review-list"),attempted=round.questions.filter(q=>attemptFor(q.id)).sort((a,b)=>new Date(attemptFor(a.id).nextReview)-new Date(attemptFor(b.id).nextReview));
  if(!attempted.length){container.innerHTML='<div class="empty">As revisões aparecerão aqui depois que você responder às questões.</div>';return}
  container.innerHTML=attempted.map(q=>{const a=attemptFor(q.id),pending=!a.nextReview,date=pending?"Após avaliar o domínio":new Intl.DateTimeFormat("pt-BR",{dateStyle:"medium"}).format(new Date(a.nextReview)),due=!pending&&new Date(a.nextReview)<=new Date();return`<article class="review-card"><span class="eyebrow">Domínio ${a.mastery??"pendente"}</span><h3>${escapeHtml(q.stem)}</h3><p>${escapeHtml(q.reference.section)}</p><span class="due">${due?"Revisão disponível":pending?date:`FSRS: retorna em ${date}`}</span></article>`}).join("");
}
function renderSyllabus(){
  const container=document.getElementById("syllabus-list");container.innerHTML=syllabus.axes.map(axis=>`<article class="syllabus-item"><button class="syllabus-button" aria-expanded="false"><div class="syllabus-title"><strong>${axis.id} — ${escapeHtml(axis.title)}</strong><span>${axis.references} referências · ${axis.share.toFixed(1)}% da lista</span></div><div class="syllabus-description"><div class="progress-track"><div class="progress-fill" style="width:${axis.progress}%"></div></div><span>${escapeHtml(axis.description)}</span></div><span class="syllabus-status">${escapeHtml(axis.status)} · ${axis.progress}%</span></button><div class="syllabus-details"><p><strong>Fontes-âncora e recortes:</strong></p><ul>${axis.anchors.map(a=>`<li>${escapeHtml(a)}</li>`).join("")}</ul></div></article>`).join("");
  container.querySelectorAll(".syllabus-button").forEach(button=>button.addEventListener("click",()=>{const item=button.closest(".syllabus-item");item.classList.toggle("open");button.setAttribute("aria-expanded",item.classList.contains("open"))}));
}
function populateLibraryFilters(){
  const select=document.getElementById("library-axis");
  select.innerHTML='<option value="">Todos os eixos</option>'+bibliography.axes.map(axis=>`<option value="${axis.id}">${axis.id} · ${escapeHtml(axis.title)}</option>`).join("");
}
function renderLibrary(){
  if(!bibliography)return;
  const totals=bibliography.totals;
  document.getElementById("library-summary").innerHTML=`<div class="stat"><strong>${totals.numberedReferences}</strong><span>referências oficiais</span></div><div class="stat"><strong>${totals.distinctTitles}</strong><span>títulos distintos</span></div><div class="stat"><strong>${totals.studyUnits}</strong><span>unidades de estudo</span></div><div class="stat"><strong>${totals.driveDocumentsApprox}+</strong><span>arquivos catalogados</span></div>`;
  const query=document.getElementById("library-search")?.value.trim().toLocaleLowerCase("pt-BR")||"",axis=document.getElementById("library-axis")?.value||"",priority=document.getElementById("library-priority")?.value||"";
  const rows=bibliography.references.filter(item=>(!axis||item.axis===axis)&&(!priority||item.priority===priority)&&(!query||[item.id,item.author,item.publication,item.edition,item.scope].join(" ").toLocaleLowerCase("pt-BR").includes(query)));
  document.getElementById("library-count").textContent=`${rows.length} de ${totals.numberedReferences} referências exibidas`;
  document.getElementById("library-list").innerHTML=rows.length?rows.map(item=>`<article class="library-card"><div class="library-card-head"><span class="reference-id">${item.id}</span><span class="priority priority-${item.priority.toLowerCase()}">Prioridade ${item.priority}</span></div><h3>${escapeHtml(item.publication)}</h3><p class="library-author">${escapeHtml(item.author)} · ${escapeHtml(item.edition)}</p><details><summary>Ver recorte exigido</summary><p>${escapeHtml(item.scope)}</p>${item.note?`<p class="library-note">${escapeHtml(item.note)}</p>`:""}</details><div class="library-flags"><span>✓ Catalogada</span>${item.duplicated?'<span>↔ Unidade compartilhada</span>':""}<span>${item.studyStatus==="consolidado"?"Consolidado":item.studyStatus==="em_estudo"?"Em estudo":"A programar"}</span></div></article>`).join(""):'<div class="empty">Nenhuma referência corresponde aos filtros.</div>';
}
function renderPerformance(){
  const attempts=roundAttempts(),answered=attempts.length,correct=attempts.filter(a=>a.correct).length,rated=attempts.filter(a=>a.mastery!==null&&a.mastery!==undefined),masteryAverage=rated.length?rated.reduce((sum,a)=>sum+a.mastery,0)/rated.length:0,accuracy=answered?Math.round(correct/answered*100):0,averageTime=answered?Math.round(attempts.reduce((sum,a)=>sum+(a.responseTimeSeconds||0),0)/answered):0;
  document.getElementById("performance-cards").innerHTML=`<div class="stat"><strong>${accuracy}%</strong><span>acerto nesta rodada</span></div><div class="stat"><strong>${masteryAverage.toFixed(1)}</strong><span>domínio médio (0–3)</span></div><div class="stat"><strong>${averageTime}s</strong><span>tempo médio por questão</span></div><div class="stat"><strong>${syllabus.baseline.score}/${syllabus.baseline.maximum}</strong><span>última rodada registrada</span></div>`;
  const counts=[0,1,2,3].map(score=>attempts.filter(a=>a.mastery===score).length),labels=["0 · Errou","1 · Difícil","2 · Com esforço","3 · Fácil"];
  document.getElementById("mastery-bars").innerHTML=labels.map((label,score)=>`<div class="mastery-row"><span>${label}</span><div class="progress-track"><div class="progress-fill" data-score="${score}" style="width:${answered?counts[score]/answered*100:0}%"></div></div><strong>${counts[score]}</strong></div>`).join("");document.getElementById("report-json").textContent=JSON.stringify(buildReport(),null,2);
}
function buildReport(){
  const records=round.questions.filter(q=>attemptFor(q.id)).map(q=>{const a=attemptFor(q.id);return{questionId:q.id,category:q.category,axis:q.axis,kind:q.kind,referenceId:q.reference.referenceId||null,reference:q.reference.section,correct:a.correct,selected:letter(a.selected),answer:letter(q.correct),mastery:a.mastery,errorCause:a.errorCause||null,responseTimeSeconds:a.responseTimeSeconds||null,mode:a.mode||state.mode,answeredAt:a.answeredAt,updatedAt:a.updatedAt||a.answeredAt,nextReview:a.nextReview}});
  const byCategory=Object.fromEntries(["review","current","rotation","official"].map(category=>{const rows=records.filter(r=>r.category===category);return[category,{answered:rows.length,correct:rows.filter(r=>r.correct).length}]}));
  return{schema:"pscpp-study-report/v3",generatedAt:new Date().toISOString(),student:"Gustavo Ponzi Seibel",scheduler:"FSRS 6 via ts-fsrs",storage:"IndexedDB via Dexie, com contingência em localStorage",bibliography:{schema:bibliography.schema,referenceCount:bibliography.totals.numberedReferences,validationRequired:true},method:{name:"progressão em espiral intercalada e adaptativa",dailyMix:{review:4,current:3,rotation:2,official:1},selectionWeights:{reviewUrgency:40,personalWeakness:25,historicalIncidence:20,coverageGap:10,normativeRecency:5}},currentPath:`${round.title} — ${round.path}`,roundId:round.roundId,mode:state.mode,baseline:syllabus.baseline,summary:{answered:records.length,correct:records.filter(r=>r.correct).length,wrong:records.filter(r=>!r.correct).length,dueReviews:dueAttempts().length,byCategory},attempts:records,instructionForNextRound:"Gerar exatamente 10 questões no mix 4 revisões FSRS, 3 do tema principal, 2 de matérias alternadas e 1 questão oficial histórica. Antes de publicar, localizar cada referenceId em data/bibliography.json, abrir a obra correspondente no Drive e validar enunciado, resposta, distratores e evidência no recorte oficial. Selecionar por 40% urgência, 25% fraqueza pessoal, 20% incidência histórica, 10% lacuna de cobertura e 5% atualidade normativa. Priorizar notas 0 e 1, causas de erro e revisões vencidas; intercalar eixos; citar publicação, edição, seção e item do conteúdo programático; não revelar o parágrafo que denuncia a resposta antes da correção."}
}
function downloadReport(){const blob=new Blob([JSON.stringify(buildReport(),null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`pscpp-study-report-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url)}
boot();
