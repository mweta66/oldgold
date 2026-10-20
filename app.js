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
const loginDialog = document.querySelector('#loginDialog');
const openLogin = () => loginDialog.showModal();
document.querySelector('#accountBtn').addEventListener('click', openLogin);
document.querySelector('#bannerLogin').addEventListener('click', openLogin);
document.querySelector('#loginForm').addEventListener('submit', event => {
  event.preventDefault();
  loginDialog.close();
  document.querySelector('main').classList.remove('locked');
  document.querySelector('#accessBanner').innerHTML = '<strong>وضع العرض التجريبي</strong><span>تم فتح الواجهة فقط. الإشارات الحقيقية لا تُعرض قبل ربط Backend للمصادقة والصلاحيات.</span>';
  document.querySelector('#accountBtn').firstChild.textContent = 'حساب تجريبي ';
});
document.querySelector('#createUser').addEventListener('click', () => {
  document.querySelector('#adminMessage').textContent = 'تم تجهيز نموذج الحساب. الحفظ الفعلي يحتاج API وقاعدة بيانات؛ لا يتم حفظ بيانات الحسابات في المتصفح.';
});
document.querySelector('#telegramHelp').addEventListener('click', () => {
  document.querySelector('#adminMessage').textContent = 'أنشئ Bot عبر BotFather، أضفه Admin إلى الجروب، ثم احفظ القيم سرّيًا على الخادم: TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID. لا تضعها في JavaScript أو GitHub.';
});
