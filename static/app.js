const $ = id => document.getElementById(id);
let items = [], running = false, stopped = false, token, downloading = false, activePreset = 'balance';
const presets = {
  light: {quality:92, size:0, description:'Лёгкое: качество 92%, исходные размеры. Для сохранения деталей.'},
  medium: {quality:70, size:2560, description:'Среднее: качество 70%, сторона до 2560 px. Для небольших файлов.'},
  strong: {quality:45, size:1920, description:'Сильное: качество 45%, сторона до 1920 px. Потеря деталей заметнее.'},
  balance: {quality:80, size:0, description:'Баланс: качество 80%, исходные размеры. Отправная точка для сравнения качества и веса.'}
};
const bytes = n => n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1024 / 1024).toFixed(1)} МБ`;
const config = fetch('/api/config').then(r => r.json()).then(c => token = c.token);
config.catch(() => $('message').textContent = 'Сервер недоступен. Перезапустите приложение.');
function add(files) {
  if (running) return;
  let rejected = 0;
  for (const file of files) {
    if (!/\.(jpe?g|png|webp|bmp|tiff?|heic|heif)$/i.test(file.name) || file.size > 50 * 1024 * 1024 || !file.size || items.length >= 2000) { rejected++; continue; }
    items.push({file, status:'waiting', preview:URL.createObjectURL(file)});
  }
  $('message').textContent = rejected ? `Пропущено файлов: ${rejected}. Допустимы JPG, PNG, WebP, BMP, HEIC/HEIF, TIF/TIFF до 50 МБ, до 2000 файлов в очереди.` : '';
  render();
}
function render() {
  $('count').textContent = items.length;
  $('empty').hidden = items.length > 0;
  $('start').disabled = running || downloading || !items.length;
  $('start').textContent = items.some(i => i.result) ? 'Сжать заново →' : 'Сжать изображения →';
  $('clear').disabled = running || downloading;
  $('settings-open').disabled = running;
  const extra = [Number($('rotation').value) ? `Поворот ${$('rotation').value}°` : '', $('flip').value !== 'none' ? 'Отражение' : ''].filter(Boolean);
  $('settings-summary').textContent = [($('format').value === 'png' || ($('format').value === 'webp' && $('lossless').checked)) ? 'Без потерь' : `Качество ${$('quality').value}%`, Number($('size').value) ? `До ${$('size').value} px` : 'Исходный размер', ...extra].join(' · ');
  $('run-hint').textContent = running ? 'Обрабатываем до 3 файлов одновременно…' : items.length ? 'Можно менять настройки и сжимать оригиналы заново' : 'Добавьте изображения, чтобы начать';
  $('drop').style.minHeight = items.length ? '110px' : '';
  document.querySelectorAll('[data-preset]').forEach(button => { button.disabled = running; button.setAttribute('aria-pressed', String(button.dataset.preset === activePreset)); });
  $('stop').hidden = !running;
  for (const id of ['format','quality','size','keep','files','rotation','flip','lossless','background']) $(id).disabled = running || (id === 'quality' && ($('format').value === 'png' || ($('format').value === 'webp' && $('lossless').checked))) || (id === 'lossless' && $('format').value !== 'webp') || (id === 'background' && $('format').value !== 'jpg');
  $('list').replaceChildren(...items.map(item => {
    const row = document.createElement('div'); row.className = `row ${item.status}`;
    const img = document.createElement('img'); img.src = item.preview; img.alt = ''; img.loading = 'lazy';
    img.onerror = () => { img.hidden = true; }; // HEIC/TIFF previews are not supported by every browser.
    const thumb = document.createElement('button'); thumb.className = 'thumbnail'; thumb.title = `Открыть ${item.file.name}`; thumb.setAttribute('aria-label', thumb.title); thumb.append(img); thumb.onclick = () => openPreview(item);
    const details = document.createElement('div'); details.className = 'details';
    const name = document.createElement('strong'); name.textContent = item.file.name; name.title = item.file.name;
    const meta = document.createElement('small'); meta.textContent = bytes(item.file.size) + (item.result ? ` → ${bytes(item.result.size)}` : '');
    details.append(name, meta);
    const badge = document.createElement('span'); badge.className = 'badge';
    badge.textContent = item.status === 'waiting' ? 'В очереди' : item.status === 'working' ? 'Сжимаем…' : item.status === 'error' ? item.error : item.result.kept ? 'Оригинал меньше' : `${Math.round((1-item.result.size/item.file.size)*100)}% экономии`;
    row.append(thumb, details, badge);
    if (item.result) { const a = document.createElement('a'); a.href = `/api/file/${item.result.id}`; a.className = 'file-download'; a.textContent = '↓ Скачать файл'; a.download = item.result.name; a.title = `Скачать ${item.result.name} без ZIP`; row.append(a); }
    return row;
  }));
  const done = items.filter(i => i.result);
  const completed = items.filter(i => ['done','error'].includes(i.status)).length;
  $('summary').hidden = !running && !completed;
  $('progress').value = items.length ? completed/items.length*100 : 0;
  $('progress-label').textContent = `${running ? 'Обработка' : stopped ? 'Очередь остановлена' : 'Результаты'} · ${completed} из ${items.length}`;
  const before = done.reduce((a,i) => a+i.file.size,0), after = done.reduce((a,i) => a+i.result.size,0);
  $('savings').textContent = before ? `${bytes(before)} → ${bytes(after)} · ${Math.round((1-after/before)*100)}% экономии` : 'Готовим изображения…';
  $('download').disabled = !done.length || running || downloading;
  $('download-files').disabled = !done.length || running || downloading;
  $('download-files').textContent = downloading ? 'Подготавливаем скачивание…' : done.length === 1 ? 'Скачать изображение без ZIP ↓' : `Скачать без ZIP · ${done.length} ↓`;
}
$('files').addEventListener('change', e => { add(e.target.files); e.target.value = ''; });
$('drop').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('files').click(); } });
for (const event of ['dragenter','dragover']) $('drop').addEventListener(event, e => {e.preventDefault(); $('drop').classList.add('over');});
for (const event of ['dragleave','drop']) $('drop').addEventListener(event, e => {e.preventDefault(); $('drop').classList.remove('over'); if(event === 'drop') add(e.dataTransfer.files);});
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
$('quality').oninput = () => $('quality-value').textContent = `${$('quality').value}%`;
$('format').onchange = () => { $('note').textContent = {webp:'WebP сохраняет прозрачность и хорошо подходит для сайтов и повседневных задач.',jpg:'JPEG подходит для фото. Цвет подложки для прозрачности выбирается в расширенных настройках.',png:'PNG сжимается без потерь. Качество не регулируется; уменьшение размеров меняет изображение.'}[$('format').value]; render(); };
$('clear').onclick = () => { items.forEach(i => URL.revokeObjectURL(i.preview)); items = []; $('message').textContent = ''; render(); };
$('stop').onclick = () => {stopped = true; $('stop').disabled = true; $('stop').textContent = 'Завершаем текущие файлы…';};
$('start').onclick = async () => {
  running = true; stopped = false; $('message').textContent = ''; $('stop').disabled = false; $('stop').textContent = 'Остановить очередь';
  items.forEach(i => { i.status = 'waiting'; i.result = null; i.error = null; });
  const settings = {format:$('format').value, quality:$('quality').value, size:$('size').value, keep:$('keep').checked, rotation:$('rotation').value, flip:$('flip').value, lossless:$('format').value === 'webp' && $('lossless').checked, background:$('background').value};
  render();
  try {
    await config;
    const worker = async () => {
      while (!stopped) {
        const item = items.find(i => i.status === 'waiting'); if (!item) break;
        item.status = 'working'; render();
        try {
          const query = new URLSearchParams({...settings, name:item.file.name});
          const response = await fetch(`/api/compress?${query}`, {method:'POST', headers:{'X-App-Token':token}, body:item.file});
          const result = await response.json(); if (!response.ok) throw new Error(result.error);
          item.result = result; item.status = 'done';
        } catch(error) {item.status = 'error'; item.error = error.message || 'Ошибка соединения';}
        render();
      }
    };
    await Promise.all(Array.from({length:3},worker));
  } catch(error) { $('message').textContent = 'Нет соединения с сервером. Обновите страницу.'; }
  finally {running = false; render();}
};
$('download').onclick = async () => {
  downloading = true; render(); $('download').textContent = 'Собираем архив…';
  try {
    const response = await fetch('/api/zip', {method:'POST', headers:{'X-App-Token':token, 'Content-Type':'application/json'}, body:JSON.stringify(items.filter(i => i.result).map(i => i.result.id))});
    if (!response.ok) throw new Error('Не удалось собрать архив');
    const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = 'imagepress.zip'; a.click(); setTimeout(() => URL.revokeObjectURL(url),60000);
  } catch(error) {$('message').textContent = error.message;}
  finally {downloading = false; $('download').textContent = 'Скачать ZIP ↓'; render();}
};
$('download-files').onclick = async () => {
  const results = items.filter(i => i.result).map(i => i.result);
  if (!results.length || running || downloading) return;
  downloading = true; render();
  $('message').textContent = results.length > 1 ? 'Если браузер запросит разрешение на скачивание нескольких файлов, разрешите его. Также каждый файл можно скачать кнопкой в списке.' : '';
  try {
    for (const result of results) {
      const a = document.createElement('a'); a.href = `/api/file/${result.id}`; a.download = result.name; document.body.append(a); a.click(); a.remove();
      if(results.length > 1) await new Promise(resolve => setTimeout(resolve, 400));
    }
  } finally {downloading = false; render();}
};
document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => {
  const preset = presets[button.dataset.preset];
  if(running) return;
  if($('format').value === 'png') { $('format').value = 'webp'; $('format').onchange(); }
  $('quality').value = preset.quality; $('quality-value').textContent = `${preset.quality}%`;
  $('size').value = preset.size; $('lossless').checked = false;
  activePreset = button.dataset.preset;
  $('preset-description').textContent = preset.description + ' Формат: ' + $('format').value.toUpperCase() + '.';
  render();
}));
for(const id of ['quality', 'size', 'format', 'lossless']) $(id).addEventListener('input', () => {
  activePreset = null; $('preset-description').textContent = 'Свои настройки. Можно сжать заново и сравнить результат.'; render();
});
window.addEventListener('beforeunload', e => {if(running){e.preventDefault();e.returnValue='';}});
render();

$('settings-open').onclick = () => $('settings-dialog').showModal();
for (const id of ['settings-close','settings-done']) $(id).onclick = () => { $('settings-dialog').close(); render(); };
for (const id of ['rotation','flip','background','keep']) $(id).addEventListener('input', render);

$('lossless').onchange = render;
let previewVersion = 0, previewUrl;
$('preview-close').onclick = () => $('preview-dialog').close();
$('preview-dialog').addEventListener('close', () => { previewVersion++; if(previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; $('preview-image').removeAttribute('src'); });
async function openPreview(item) {
  const version = ++previewVersion;
  $('preview-title').textContent = item.file.name + ' · оригинал';
  $('preview-status').textContent = 'Открываем изображение…';
  $('preview-image').hidden = true;
  $('preview-download').hidden = !item.result;
  if(item.result) { $('preview-download').href = `/api/file/${item.result.id}`; $('preview-download').download = item.result.name; }
  $('preview-dialog').showModal();
  try {
    let url = item.preview;
    if (/\.(heic|heif|tiff?)$/i.test(item.file.name)) {
      await config;
      const response = await fetch('/api/preview?' + new URLSearchParams({name:item.file.name}), {method:'POST', headers:{'X-App-Token':token}, body:item.file});
      if (!response.ok) throw new Error('Не удалось подготовить превью');
      const blob = await response.blob();
      if(version !== previewVersion) return;
      previewUrl = URL.createObjectURL(blob); url = previewUrl;
    }
    if(version !== previewVersion) return;
    const image = $('preview-image');
    image.onload = () => { if(version === previewVersion) $('preview-status').textContent = ''; };
    image.onerror = () => { if(version === previewVersion) $('preview-status').textContent = 'Браузер не смог открыть изображение.'; };
    image.src = url; image.hidden = false;
  } catch(error) { if(version === previewVersion) $('preview-status').textContent = error.message; }
}
