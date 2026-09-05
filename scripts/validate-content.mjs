import { readFile } from "node:fs/promises";

const readJson=async path=>JSON.parse(await readFile(new URL(`../${path}`,import.meta.url),"utf8"));
const [round,bibliography,syllabus]=await Promise.all([
  readJson("data/questions.json"),
  readJson("data/bibliography.json"),
  readJson("data/syllabus.json")
]);
const errors=[];
const fail=(message)=>errors.push(message);
const referenceIds=new Set(bibliography.references.map(item=>item.id));
const axisIds=new Set(syllabus.axes.map(item=>item.id));
const expectedMix={review:4,current:3,rotation:2,official:1};

if(round.questions.length!==10)fail(`A rodada deve ter 10 questões; recebeu ${round.questions.length}.`);
for(const [category,expected] of Object.entries(expectedMix)){
  const actual=round.questions.filter(question=>question.category===category).length;
  if(actual!==expected)fail(`Mix inválido em ${category}: esperado ${expected}, recebido ${actual}.`);
}
const seen=new Set();
round.questions.forEach((question,index)=>{
  const label=`Questão ${index+1} (${question.id||"sem id"})`;
  if(!question.id||seen.has(question.id))fail(`${label}: ID ausente ou duplicado.`);seen.add(question.id);
  if(!question.stem||!Array.isArray(question.options)||question.options.length<4)fail(`${label}: enunciado/opções incompletos.`);
  if(!Number.isInteger(question.correct)||question.correct<0||question.correct>=question.options.length)fail(`${label}: índice da resposta inválido.`);
  if(!Array.isArray(question.comments)||question.comments.length!==question.options.length)fail(`${label}: cada alternativa precisa de comentário.`);
  if(!question.explanation)fail(`${label}: explicação ausente.`);
  const ref=question.reference||{};
  if(!referenceIds.has(ref.referenceId))fail(`${label}: referenceId ${ref.referenceId||"ausente"} não existe no catálogo.`);
  if(!ref.publication||!ref.edition||!ref.section||!ref.syllabus||!ref.evidence)fail(`${label}: referência/evidência incompleta.`);
  const axes=String(question.axis||"").split("/");
  if(!axes.every(axis=>axisIds.has(axis)))fail(`${label}: eixo inválido (${question.axis}).`);
});

if(bibliography.references.length!==bibliography.totals.numberedReferences)fail("Total do catálogo não coincide com as referências listadas.");
if(new Set(bibliography.references.map(item=>item.id)).size!==bibliography.references.length)fail("Há IDs duplicados na bibliografia.");

if(errors.length){console.error(`Validação de conteúdo falhou:\n- ${errors.join("\n- ")}`);process.exit(1)}
console.log(`Conteúdo validado: ${round.questions.length} questões, ${bibliography.references.length} referências e mix 4–3–2–1.`);
