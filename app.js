const update = document.querySelector('#refreshBtn');
const toast = document.querySelector('#toast');
const time = document.querySelector('#lastUpdate');
update.addEventListener('click', () => { time.textContent = 'الآن'; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2200); });
document.querySelector('#detailsBtn').addEventListener('click', event => { event.currentTarget.textContent = 'تفاصيل الإشارة متاحة للمشتركين'; event.currentTarget.style.background = '#2a332f'; event.currentTarget.style.color = '#8fe0bb'; });
