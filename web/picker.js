// Shared illustrated single-select for all shelf, studio and family forms.
const pick = (() => {
  const escape = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let open = null;
  function close() {
    if (!open) return;
    open.querySelector('[role=listbox]').hidden = true;
    const button = open.querySelector('button');
    button.setAttribute('aria-expanded','false');
    button.removeAttribute('aria-activedescendant');
    open = null;
  }
  function highlight(index) {
    const rows = [...open.querySelectorAll('[role=option]')];
    const active = rows[Math.max(0, Math.min(index, rows.length-1))];
    rows.forEach(row => row.classList.toggle('active',row===active));
    open.querySelector('button').setAttribute('aria-activedescendant',active.id);
    active.scrollIntoView({block:'nearest'});
  }
  function expand(field) {
    close(); open=field;
    const button=field.querySelector('button');
    button.focus(); button.setAttribute('aria-expanded','true');
    field.querySelector('[role=listbox]').hidden=false;
    highlight([...field.querySelectorAll('[role=option]')].findIndex(row=>row.getAttribute('aria-selected')==='true'));
  }
  function choose(row) {
    const field=open, button=field.querySelector('button'), input=field.querySelector('input');
    input.value=row.dataset.value;
    field.querySelectorAll('[role=option]').forEach(item=>item.setAttribute('aria-selected',String(item===row)));
    button.innerHTML=row.querySelector('.pick-caption').innerHTML+icon('chevron-down',15);
    close();button.focus();
    input.dispatchEvent(new Event('change',{bubbles:true}));
  }
  // Keep focus on the combobox until the option's click commits the value.
  // Otherwise a modal can take focus on mousedown and close the list first.
  document.addEventListener('mousedown',e=>{
    if(e.button===0 && open?.contains(e.target.closest('[role=option]')))e.preventDefault();
  });
  document.addEventListener('click',e=>{
    const button=e.target.closest('.picker [role=combobox]');
    if(button){const field=button.closest('.picker'); if(open===field)close();else expand(field);return;}
    const row=e.target.closest('.picker [role=option]');
    if(row && open?.contains(row)) choose(row);else close();
  });
  document.addEventListener('focusin',e=>{if(open&&!open.contains(e.target))close()});
  document.addEventListener('keydown',e=>{
    const button=e.target.closest('.picker [role=combobox]');
    if(!button)return;
    const field=button.closest('.picker');
    if(e.key==='Escape' && open===field){e.preventDefault();e.stopPropagation();close();return;}
    if(e.key==='Tab'){close();return;}
    if(!['ArrowDown','ArrowUp','Home','End','Enter',' '].includes(e.key))return;
    e.preventDefault();
    const wasOpen=open===field;
    if(!wasOpen)expand(field);
    const rows=[...field.querySelectorAll('[role=option]')];
    const i=rows.findIndex(row=>row.classList.contains('active'));
    if(['Enter',' '].includes(e.key)){if(wasOpen)choose(rows[i]);}
    else if(e.key==='Home')highlight(0);
    else if(e.key==='End')highlight(rows.length-1);
    else if(wasOpen)highlight(i+(e.key==='ArrowDown'?1:-1));
  });
  return function(name,label,choices,value) {
    if(!choices.length)return '';
    const selected=choices.find(c=>c[0]===value)||choices[0];
    const content=c=>icon(c[2]||'flower',20)+escape(c[1]);
    const id='pick-'+name;
    return '<div class="picker"><span class="picker-label" id="'+id+'-label">'+escape(label)+'</span>'+
      '<input type="hidden" name="'+name+'" value="'+escape(selected[0])+'"><button type="button" role="combobox" aria-expanded="false" aria-controls="'+id+'-options" aria-labelledby="'+id+'-label"  >'+content(selected)+icon('chevron-down',15)+'</button>'+
      '<div role="listbox" id="'+id+'-options" aria-labelledby="'+id+'-label" hidden>'+choices.map((c,i)=>'<div role="option" id="'+id+'-'+i+'" aria-selected="'+(c===selected)+'" data-value="'+escape(c[0])+'" ><span class="pick-caption">'+content(c)+'</span><span class="pick-check">'+icon('check',16)+'</span></div>').join('')+'</div></div>';
  };
})();
