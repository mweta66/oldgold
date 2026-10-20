const update = document.querySelector('#refreshBtn');
const toast = document.querySelector('#toast');
const time = document.querySelector('#lastUpdate');
update.addEventListener('click', () => { time.textContent = 'الآن'; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2200); });
document.querySelectorAll('.timeframes button').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.timeframes button').forEach(item => item.classList.remove('selected'));
  button.classList.add('selected');
  const chart = document.querySelector('#tradingviewChart');
  const interval = button.textContent === '1M' ? '1' : button.textContent === '15M' ? '15' : button.textContent === '1H' ? '60' : 'D';
  chart.src = `https://www.tradingview.com/widgetembed/?symbol=OANDA%3AXAUUSD&interval=${interval}&hidesidebar=1&symboledit=0&theme=dark&style=1`;
}));
document.querySelector('#detailsBtn').addEventListener('click', event => { event.currentTarget.textContent = 'تفاصيل الإشارة متاحة للمشتركين'; event.currentTarget.style.background = '#2a332f'; event.currentTarget.style.color = '#8fe0bb'; });
