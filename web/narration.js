// Device preview for unpublished text. Recorded releases use the audio element.
function narrationPhrases(text) {
  return text.match(/[^。！？；\n]{1,100}[。！？；]*[”’」』]?|[。！？；]+/gu) || [];
}

async function localMandarinVoice() {
  const synth=window.speechSynthesis;
  if(!synth)return null;
  if(!synth.getVoices().length)await new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);synth.removeEventListener('voiceschanged',done);resolve()};
    const timer=setTimeout(done,800);
    synth.addEventListener('voiceschanged',done,{once:true});
  });
  const score=v=>(/zh[-_]CN|zh[-_]Hans|cmn/i.test(v.lang)?10:0)+(/enhanced|premium|natural|增强|优质|siri/i.test(v.name)?20:0);
  return synth.getVoices().filter(v=>v.localService && /^(zh|cmn)/i.test(v.lang) && !/yue|zh[-_]HK/i.test(v.lang))
    .sort((a,b)=>score(b)-score(a))[0]||null;
}
function makeUtterance(text,style,voice){
  const u=new SpeechSynthesisUtterance(text);
  u.voice=voice;u.lang=voice.lang;
  u.rate=style==='轻快晨读'?.98:.9;
  return u;
}
