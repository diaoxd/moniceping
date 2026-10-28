(function(){
  const periods=[5,10,20,60,100];
  const colors=['#f4d546','#4389ff','#b92398','#f28c38','#d7e2ec'];
  function update(){
    const state=JSON.parse(sessionStorage.getItem('randomTrainingState')||'null');
    if(!state)return;
    const activeIndex=[...document.querySelectorAll('.chart-actions .ghost')].findIndex(function(button){return button.classList.contains('active')});const period=['daily','weekly','monthly'][activeIndex>=0?activeIndex:0];const bars=state.bars&&state.bars[period]||[];
    const settings=JSON.parse(localStorage.getItem('trainingIndicatorSettings')||'null')||{periods:periods,enabled:periods.map(function(){return true})};
    const strip=document.querySelector('.indicator-strip');
    if(!strip||!bars.length)return;
    strip.querySelectorAll('.ma-live-value').forEach(function(n){n.remove()});
    settings.periods.forEach(function(period,i){
      if(!settings.enabled[i])return;
      const values=bars.slice(-period).map(function(b){return b.closeCents});
      const value=values.length===period?values.reduce(function(a,b){return a+b},0)/period:null;
      const item=document.createElement('span');item.className='ma-live-value';item.style.color=colors[i];item.textContent='MA'+period+' '+(value===null?'--':(value/100).toFixed(2));strip.appendChild(item);
    });
  }
  setInterval(update,300);if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',update);else update();
})();
