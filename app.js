const update = document.querySelector('#refreshBtn');
const toast = document.querySelector('#toast');
const time = document.querySelector('#lastUpdate');
const chart = document.querySelector('#priceChart');
const loading = document.querySelector('#chartLoading');
const chartTag = document.querySelector('#chartTag');
const chartTime = document.querySelector('#chartTime');
const BYBIT_SYMBOL = 'XAUTUSDT';
const candlesUrl = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${BYBIT_SYMBOL}&interval=1&limit=120`;

function drawChart(rows) {
  const rect = chart.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
  chart.width = rect.width * ratio; chart.height = rect.height * ratio;
  const ctx = chart.getContext('2d'); ctx.scale(ratio, ratio);
  const width = rect.width, height = rect.height, pad = 22;
  const values = rows.map(row => Number(row[4]));
  const min = Math.min(...values), max = Math.max(...values);
  const x = i => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = value => height - pad - ((value - min) / Math.max(max - min, 0.000001)) * (height - pad * 2);
  ctx.beginPath(); values.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.lineTo(x(values.length - 1), height - pad); ctx.lineTo(x(0), height - pad); ctx.closePath();
  const fill = ctx.createLinearGradient(0, 0, 0, height); fill.addColorStop(0, 'rgba(214,181,107,.25)'); fill.addColorStop(1, 'rgba(214,181,107,0)'); ctx.fillStyle = fill; ctx.fill();
  ctx.beginPath(); values.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))); ctx.strokeStyle = '#d6b56b'; ctx.lineWidth = 2.5; ctx.stroke();
  const last = values[values.length - 1]; chartTag.textContent = Number(last).toLocaleString('en-US', {maximumFractionDigits: 2}); chartTag.style.top = `${Math.max(5, Math.min(85, y(last) / height * 100))}%`;
  chartTime.textContent = new Date(Number(rows[rows.length - 1][0])).toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'});
}

async function loadLiveChart() {
  try { const payload = await (await fetch(candlesUrl)).json(); if (payload.retCode !== 0 || !payload.result?.list?.length) throw new Error(); drawChart(payload.result.list.reverse()); loading.hidden = true; time.textContent = 'الآن'; }
  catch { loading.textContent = `تعذر تحميل ${BYBIT_SYMBOL} من Bybit — تحقق من رمز السوق`; }
}
loadLiveChart(); setInterval(loadLiveChart, 30000); window.addEventListener('resize', loadLiveChart);
update.addEventListener('click', () => { loadLiveChart(); time.textContent = 'جارٍ التحديث'; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2200); });
document.querySelector('#detailsBtn').addEventListener('click', event => { event.currentTarget.textContent = 'تفاصيل الإشارة متاحة للمشتركين'; event.currentTarget.style.background = '#2a332f'; event.currentTarget.style.color = '#8fe0bb'; });
