import Dexie from "dexie";
import { Rating, createEmptyCard, fsrs } from "ts-fsrs";

const STORAGE_KEY="pscpp-study-radar-v2";
const LEGACY_STORAGE_KEY="pscpp-study-radar-v1";
const scheduler=fsrs({enable_fuzz:false,enable_short_term:false});
const database=new Dexie("pscpp-study-radar");
database.version(1).stores({settings:"key",attempts:"questionId,answeredAt,nextReview,mastery"});
const letter=i=>String.fromCharCode(97+i);
const escapeHtml=value=>String(value).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
let round,syllabus,currentIndex=0,state={attempts:{},startedAt:new Date().toISOString()};

async function loadState(){
  try{
    const rows=await database.table("attempts").toArray();
    const meta=await database.table("settings").get("session");
    if(rows.length)return{attempts:Object.fromEntries(rows.map(row=>[row.questionId,row])),startedAt:meta?.startedAt||new Date().toISOString()};
  }catch(error){console.warn("IndexedDB indisponível; usando armazenamento local.",error)}
  try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||localStorage.getItem(LEGACY_STORAGE_KEY))||state}catch{return state}
}
async function saveState(questionId){
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
  try{
    await database.table("settings").put({key:"session",startedAt:state.startedAt,updatedAt:new Date().toISOString()});
    if(questionId)await database.table("attempts").put({...state.attempts[questionId],questionId});
  }catch(error){console.warn("Falha ao salvar no IndexedDB; cópia local preservada.",error)}
}
function attemptFor(id){return state.attempts[id]}

async function init(){
  state=await loadState();
  try{[round,syllabus]=await Promise.all([fetch("data/questions.json").then(r=>{if(!r.ok)throw new Error();return r.json()}),fetch("data/syllabus.json").then(r=>{if(!r.ok)throw new Error();return r.json()})])}
  catch{document.querySelector("main").innerHTML='<div class="empty">Não foi possível carregar os dados da rodada. Atualize a página.</div>';return}
  document.getElementById("today-label").textContent=new Intl.DateTimeFormat("pt-BR",{dateStyle:"long"}).format(new Date());
  document.querySelector(".context-strip div:nth-child(1) strong").textContent=round.publication;
  document.querySelector(".context-strip div:nth-child(2) strong").textContent=round.path||"Apêndice 3";
  document.querySelector(".context-strip div:nth-child(3) strong").textContent=round.title;
  updateConnectionStatus();
  window.addEventListener("online",updateConnectionStatus);window.addEventListener("offline",updateConnectionStatus);
  bindTabs();bindActions();renderAll();
}

function updateConnectionStatus(){const online=navigator.onLine;document.getElementById("connection-status").textContent=online?"Online · dados locais ativos":"Offline · respostas preservadas";document.getElementById("connection-dot").classList.toggle("offline",!online)}

function bindTabs(){document.querySelectorAll(".tab").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(b=>{b.classList.toggle("active",b===button);b.setAttribute("aria-selected",b===button)});document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));document.getElementById(`view-${button.dataset.view}`).classList.add("active");if(button.dataset.view==="performance")renderPerformance()}))}
function bindActions(){
  document.getElementById("submit-answer").addEventListener("click",submitAnswer);
  document.getElementById("previous-question").addEventListener("click",()=>showQuestion(Math.max(0,currentIndex-1)));
  document.getElementById("next-question").addEventListener("click",()=>showQuestion(Math.min(round.questions.length-1,currentIndex+1)));
  document.getElementById("copy-report").addEventListener("click",async e=>{await navigator.clipboard.writeText(JSON.stringify(buildReport(),null,2));e.currentTarget.textContent="Copiado";setTimeout(()=>e.currentTarget.textContent="Copiar",1200)});
  document.getElementById("download-report").addEventListener("click",downloadReport);
}
function renderAll(){renderIndex();showQuestion(currentIndex);renderReviews();renderSyllabus();renderPerformance();updateSummary()}

function renderIndex(){
  const container=document.getElementById("question-index");
  container.innerHTML=round.questions.map((q,i)=>{const a=attemptFor(q.id),status=a?(a.correct?"right":"wrong"):"";return`<button class="index-button ${status} ${i===currentIndex?"current":""}" data-index="${i}" aria-label="Questão ${i+1}">${i+1}</button>`}).join("");
  container.querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>showQuestion(Number(b.dataset.index))));
}
function showQuestion(index){
  currentIndex=index;const q=round.questions[index],attempt=attemptFor(q.id);
  document.getElementById("question-kind").textContent=q.kind;document.getElementById("question-number").textContent=`${index+1} de ${round.questions.length}`;document.getElementById("question-source").textContent=`Referência-base: ${round.publication}`;document.getElementById("question-stem").textContent=q.stem;
  const form=document.getElementById("answers");
  form.innerHTML=q.options.map((option,i)=>{const selected=attempt?.selected===i,className=attempt?(i===q.correct?"correct":(selected?"incorrect":"")):"";return`<label class="answer ${className}"><input type="radio" name="answer" value="${i}" ${selected?"checked":""} ${attempt?"disabled":""}><strong>${letter(i)})</strong><span>${escapeHtml(option)}</span></label>`}).join("");
  const submit=document.getElementById("submit-answer");submit.hidden=Boolean(attempt);submit.disabled=true;form.querySelectorAll("input").forEach(input=>input.addEventListener("change",()=>submit.disabled=false));renderFeedback(q,attempt);document.getElementById("previous-question").disabled=index===0;document.getElementById("next-question").disabled=index===round.questions.length-1;renderIndex();
}
function submitAnswer(){
  const q=round.questions[currentIndex],chosen=document.querySelector('input[name="answer"]:checked');if(!chosen)return;const selected=Number(chosen.value),correct=selected===q.correct;
  const answeredAt=new Date();
  const base={selected,correct,mastery:correct?null:0,answeredAt:answeredAt.toISOString(),fsrsCard:createEmptyCard(answeredAt)};
  state.attempts[q.id]=correct?{...base,nextReview:null}:{...base,...scheduleCard(base.fsrsCard,Rating.Again,answeredAt)};
  saveState(q.id);renderAll();showQuestion(currentIndex);
}
function renderFeedback(q,attempt){
  const box=document.getElementById("feedback");if(!attempt){box.hidden=true;box.innerHTML="";return}box.hidden=false;
  box.innerHTML=`<h3 class="${attempt.correct?"result-right":"result-wrong"}">${attempt.correct?"Resposta correta":`Resposta incorreta · correta: ${letter(q.correct)})`}</h3><p>${escapeHtml(q.explanation)}</p><div class="option-analysis">${q.comments.map((c,i)=>`<p><strong>${letter(i)})</strong> ${escapeHtml(c)}</p>`).join("")}</div><div class="reference-box"><strong>${escapeHtml(q.reference.publication)}</strong><span>${escapeHtml(q.reference.edition)}</span><span>${escapeHtml(q.reference.section)}</span><span>${escapeHtml(q.reference.syllabus)}</span></div>${attempt.correct?masteryMarkup(attempt.mastery):'<p class="mastery"><strong>Domínio registrado: 0 — errou.</strong> A questão retornará primeiro na fila de revisão.</p>'}`;
  box.querySelectorAll("[data-mastery]").forEach(button=>button.addEventListener("click",()=>setMastery(q.id,Number(button.dataset.mastery))));
}
function masteryMarkup(current){const labels=["1 · Difícil","2 · Com esforço","3 · Fácil"];return`<div class="mastery"><p>Como você chegou à resposta correta?</p><div class="mastery-buttons">${labels.map((label,i)=>`<button data-mastery="${i+1}" class="${current===i+1?"selected":""}">${label}</button>`).join("")}</div></div>`}
function reviveCard(card){return{...card,due:new Date(card.due),last_review:card.last_review?new Date(card.last_review):undefined}}
function scheduleCard(card,rating,now=new Date()){const result=scheduler.next(reviveCard(card),now,rating);return{fsrsCard:result.card,fsrsLog:result.log,nextReview:new Date(result.card.due).toISOString()}}
function setMastery(id,mastery){const attempt=state.attempts[id],rating={1:Rating.Hard,2:Rating.Good,3:Rating.Easy}[mastery];Object.assign(attempt,{mastery,...scheduleCard(attempt.fsrsCard,rating,new Date(attempt.answeredAt))});saveState(id);renderAll();showQuestion(currentIndex)}
function dueAttempts(){const now=Date.now();return round.questions.filter(q=>{const a=attemptFor(q.id);return a?.nextReview&&new Date(a.nextReview).getTime()<=now})}
function updateSummary(){const attempts=Object.values(state.attempts),correct=attempts.filter(a=>a.correct).length;document.getElementById("round-score").textContent=`${attempts.length}/${round.questions.length} respondidas`;document.getElementById("correct-counter").textContent=`${correct} ${correct===1?"acerto":"acertos"}`;document.getElementById("review-badge").textContent=dueAttempts().length}

function renderReviews(){
  const container=document.getElementById("review-list"),attempted=round.questions.filter(q=>attemptFor(q.id)).sort((a,b)=>new Date(attemptFor(a.id).nextReview)-new Date(attemptFor(b.id).nextReview));
  if(!attempted.length){container.innerHTML='<div class="empty">As revisões aparecerão aqui depois que você responder às questões.</div>';return}
  container.innerHTML=attempted.map(q=>{const a=attemptFor(q.id),pending=!a.nextReview,date=pending?"Após avaliar o domínio":new Intl.DateTimeFormat("pt-BR",{dateStyle:"medium"}).format(new Date(a.nextReview)),due=!pending&&new Date(a.nextReview)<=new Date();return`<article class="review-card"><span class="eyebrow">Domínio ${a.mastery??"pendente"}</span><h3>${escapeHtml(q.stem)}</h3><p>${escapeHtml(q.reference.section)}</p><span class="due">${due?"Revisão disponível":pending?date:`FSRS: retorna em ${date}`}</span></article>`}).join("");
}
function renderSyllabus(){
  const container=document.getElementById("syllabus-list");container.innerHTML=syllabus.axes.map(axis=>`<article class="syllabus-item"><button class="syllabus-button" aria-expanded="false"><div class="syllabus-title"><strong>${axis.id} — ${escapeHtml(axis.title)}</strong><span>${axis.references} referências · ${axis.share.toFixed(1)}% da lista</span></div><div class="syllabus-description"><div class="progress-track"><div class="progress-fill" style="width:${axis.progress}%"></div></div><span>${escapeHtml(axis.description)}</span></div><span class="syllabus-status">${escapeHtml(axis.status)} · ${axis.progress}%</span></button><div class="syllabus-details"><p><strong>Fontes-âncora e recortes:</strong></p><ul>${axis.anchors.map(a=>`<li>${escapeHtml(a)}</li>`).join("")}</ul></div></article>`).join("");
  container.querySelectorAll(".syllabus-button").forEach(button=>button.addEventListener("click",()=>{const item=button.closest(".syllabus-item");item.classList.toggle("open");button.setAttribute("aria-expanded",item.classList.contains("open"))}));
}
function renderPerformance(){
  const attempts=Object.values(state.attempts),answered=attempts.length,correct=attempts.filter(a=>a.correct).length,rated=attempts.filter(a=>a.mastery!==null&&a.mastery!==undefined),masteryAverage=rated.length?rated.reduce((sum,a)=>sum+a.mastery,0)/rated.length:0,accuracy=answered?Math.round(correct/answered*100):0;
  document.getElementById("performance-cards").innerHTML=`<div class="stat"><strong>${accuracy}%</strong><span>acerto nesta rodada</span></div><div class="stat"><strong>${masteryAverage.toFixed(1)}</strong><span>domínio médio (0–3)</span></div><div class="stat"><strong>${dueAttempts().length}</strong><span>revisões disponíveis</span></div><div class="stat"><strong>26/30</strong><span>linha de base importada</span></div>`;
  const counts=[0,1,2,3].map(score=>attempts.filter(a=>a.mastery===score).length),labels=["0 · Errou","1 · Difícil","2 · Com esforço","3 · Fácil"];
  document.getElementById("mastery-bars").innerHTML=labels.map((label,score)=>`<div class="mastery-row"><span>${label}</span><div class="progress-track"><div class="progress-fill" data-score="${score}" style="width:${answered?counts[score]/answered*100:0}%"></div></div><strong>${counts[score]}</strong></div>`).join("");document.getElementById("report-json").textContent=JSON.stringify(buildReport(),null,2);
}
function buildReport(){
  const records=round.questions.filter(q=>attemptFor(q.id)).map(q=>{const a=attemptFor(q.id);return{questionId:q.id,reference:q.reference.section,correct:a.correct,selected:letter(a.selected),answer:letter(q.correct),mastery:a.mastery,answeredAt:a.answeredAt,nextReview:a.nextReview}});
  return{schema:"pscpp-study-report/v2",generatedAt:new Date().toISOString(),student:"Gustavo Ponzi Seibel",scheduler:"FSRS 6 via ts-fsrs",storage:"IndexedDB via Dexie, com contingência em localStorage",currentPath:`${round.publication} — ${round.path||round.title}`,roundId:round.roundId,baseline:syllabus.baseline,summary:{answered:records.length,correct:records.filter(r=>r.correct).length,wrong:records.filter(r=>!r.correct).length,dueReviews:dueAttempts().length},attempts:records,instructionForNextRound:"Priorizar notas 0 e 1 e revisões vencidas; manter revisão cumulativa; avançar somente após domínio do ponto atual; citar publicação, edição, seção e item do conteúdo programático."}
}
function downloadReport(){const blob=new Blob([JSON.stringify(buildReport(),null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=`pscpp-study-report-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url)}
init();
