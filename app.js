const state = {
  vehicles: [],
  filtered: [],
  selected: null,
  photoIndex: 0,
  theme: 'violet',
  photoPosition: 50,
  priceOverride: null,
  ownerOverride: null,
  autotekaOverride: null,
  dealer: '',
  user: null,
};

const FEED_PROCESSING_TIMEOUT_MS = 120_000;
const MAX_FEED_SIZE_BYTES = 20 * 1024 * 1024;
let activeFeedOperation = null;
let authMode = 'login';

const $ = (selector) => document.querySelector(selector);
const els = {
  authScreen: $('#authScreen'), authForm: $('#authForm'), authTitle: $('#authTitle'), authDescription: $('#authDescription'),
  authEmail: $('#authEmail'), authPassword: $('#authPassword'), authConfirm: $('#authConfirm'), authConfirmField: $('#authConfirmField'),
  authSubmit: $('#authSubmit'), authError: $('#authError'), loginTab: $('#loginTab'), registerTab: $('#registerTab'),
  accountEmail: $('#accountEmail'), logoutButton: $('#logoutButton'), clearSavedFeed: $('#clearSavedFeed'),
  feedForm: $('#feedForm'), feedUrl: $('#feedUrl'), feedFile: $('#feedFile'), feedSubmit: $('#feedSubmit'),
  feedStatus: $('#feedStatus'), vehicleCount: $('#vehicleCount'), vehicleList: $('#vehicleList'), catalogState: $('#catalogState'),
  searchInput: $('#searchInput'), statusDot: $('.status-dot'), storyPreview: $('#storyPreview'), storyImage: $('#storyImage'), storyBackground: $('#storyBackground'),
  dealerLockup: $('#dealerLockup'), dealerSign: $('#dealerSign'), storyDealer: $('#storyDealer'), storyBadges: $('#storyBadges'), storyTitle: $('#storyTitle'), storySpecs: $('#storySpecs'),
  storyPrice: $('#storyPrice'), storyKicker: $('#storyKicker'), photoCounter: $('#photoCounter'), prevPhoto: $('#prevPhoto'), nextPhoto: $('#nextPhoto'),
  priceInput: $('#priceInput'), resetPrice: $('#resetPrice'), ownerToggle: $('#ownerToggle'), autotekaToggle: $('#autotekaToggle'),
  ownerHint: $('#ownerHint'), autotekaHint: $('#autotekaHint'), photoPosition: $('#photoPosition'), themeGrid: $('#themeGrid'),
  dealerInput: $('#dealerInput'), exportButton: $('#exportButton'), exportTop: $('#exportTop'), saveStoryButton: $('#saveStoryButton'), exportCanvas: $('#exportCanvas'), toast: $('#toast'),
};

function text(node, fallback = '') {
  return (node?.textContent || fallback).trim();
}

function directText(parent, tag) {
  return text(Array.from(parent.children).find((child) => child.tagName.toLowerCase() === tag.toLowerCase()));
}

function parseBoolean(value) {
  return /^(1|true|yes|да|зел[её]н|чист|успеш|пройден)/i.test(String(value || '').trim());
}

function parseFeed(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) {
    throw new Error('Фид пуст. Укажите XML-файл MaxPoster с автомобилями.');
  }
  if (new Blob([xmlText]).size > MAX_FEED_SIZE_BYTES) {
    throw new Error('Фид слишком большой. Максимальный размер — 20 МБ.');
  }

  const beginning = xmlText.replace(/^\uFEFF/, '').trimStart().slice(0, 2048);
  if (!beginning.startsWith('<') || /^<(?:!doctype\s+html|html)\b/i.test(beginning)) {
    throw new Error('Получен не XML-фид, а документ другого формата.');
  }

  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  const error = xml.querySelector('parsererror');
  if (error) throw new Error('XML не удалось прочитать. Проверьте формат файла.');

  if (xml.documentElement?.tagName.toLowerCase() !== 'yml_catalog') {
    throw new Error('Неверная структура: ожидается корневой элемент <yml_catalog>.');
  }
  if (!xml.querySelector('yml_catalog > shop > offers')) {
    throw new Error('Неверная структура: не найден раздел <shop><offers>.');
  }

  const shopName = text(xml.querySelector('shop > name'), 'Автосалон');
  const offers = Array.from(xml.querySelectorAll('offers > offer'));
  if (!offers.length) throw new Error('В XML не найдены элементы <offer>.');
  if (offers.length > 20_000) throw new Error('В фиде слишком много автомобилей. Максимум — 20 000.');

  const vehicles = offers.map((offer) => {
    const params = {};
    Array.from(offer.querySelectorAll(':scope > param')).forEach((param) => {
      params[(param.getAttribute('name') || '').trim()] = text(param);
    });
    const ownerEntry = Object.entries(params).find(([name]) => /количество\s+владельцев|владельц/i.test(name));
    const ownerCount = ownerEntry ? Number(String(ownerEntry[1]).match(/\d+/)?.[0]) || null : null;
    const description = directText(offer, 'description');
    const autotekaEntry = Object.entries(params).find(([name]) => /автотек/i.test(name));
    const greenAutoteka = autotekaEntry
      ? parseBoolean(autotekaEntry[1]) || /зел[её]н|чист|без.*огранич/i.test(autotekaEntry[1])
      : /(зел[её]н\w*\s+автотек|автотек\w*[^.\n]{0,28}(зел[её]н|чист|пройден|без огранич))/i.test(description);
    const pictures = Array.from(offer.children)
      .filter((node) => node.tagName.toLowerCase() === 'picture')
      .map((node) => text(node))
      .filter(Boolean);

    return {
      id: offer.getAttribute('id') || crypto.randomUUID(),
      vendor: directText(offer, 'vendor') || 'Автомобиль',
      model: directText(offer, 'model') || 'Без названия',
      price: Number(directText(offer, 'price')) || 0,
      pictures,
      params,
      description,
      ownerCount,
      greenAutoteka,
      shopName,
      url: directText(offer, 'url'),
    };
  }).filter((vehicle) => vehicle.pictures.length);

  if (!vehicles.length) {
    throw new Error('В предложениях не найдено ни одной фотографии автомобиля.');
  }
  return vehicles;
}

function formatPrice(value) {
  const numeric = Number(String(value || '').replace(/\D/g, '')) || 0;
  return numeric ? `${new Intl.NumberFormat('ru-RU').format(numeric)} ₽` : 'Цена по запросу';
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value) || 0);
}

function getParam(vehicle, pattern) {
  const entry = Object.entries(vehicle?.params || {}).find(([name]) => pattern.test(name));
  return entry?.[1] || '';
}

function vehicleYear(vehicle) {
  return vehicle?.model.match(/(?:19|20)\d{2}/)?.[0] || vehicle?.description.match(/(?:19|20)\d{2}/)?.[0] || '';
}

function storyName(vehicle) {
  if (!vehicle) return 'Выберите автомобиль';
  let model = vehicle.model.replace(/\s+(?:19|20)\d{2}\s*$/, '');
  model = model.replace(/\s+\d(?:[.,]\d)?\s+(?:AT|MT|AMT|CVT).*$/i, '');
  const words = model.split(/\s+/).slice(0, 6).join(' ');
  return `${vehicle.vendor} ${words}`.replace(new RegExp(`^${vehicle.vendor}\\s+${vehicle.vendor}\\s+`, 'i'), `${vehicle.vendor} `);
}

function vehicleSpecs(vehicle) {
  if (!vehicle) return [];
  const year = vehicleYear(vehicle);
  const mileage = getParam(vehicle, /пробег/i);
  const engine = getParam(vehicle, /объем двигателя/i);
  const drive = getParam(vehicle, /привод/i);
  const specs = [];
  if (year) specs.push(`${year} год`);
  if (mileage) specs.push(`${formatNumber(mileage)} км`);
  if (engine) specs.push(`${(Number(engine) / 1000).toFixed(1).replace('.', ',')} л`);
  else if (drive) specs.push(drive);
  return specs.slice(0, 3);
}

function imageUrl(url, forceProxy = false) {
  if (!url) return '';
  const canProxy = location.protocol.startsWith('http') && !url.startsWith(location.origin);
  return (canProxy && forceProxy) ? `/api/image?url=${encodeURIComponent(url)}` : url;
}

function ownerEnabled() {
  if (!state.selected) return false;
  return state.ownerOverride ?? state.selected.ownerCount === 1;
}

function autotekaEnabled() {
  if (!state.selected) return false;
  return state.autotekaOverride ?? state.selected.greenAutoteka;
}

function currentPrice() {
  return state.priceOverride ?? state.selected?.price ?? 0;
}

function showToast(message, kind = 'ok') {
  els.toast.textContent = message;
  els.toast.className = `toast show ${kind === 'error' ? 'error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.className = 'toast'; }, 2800);
}

async function responseMessage(response) {
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const payload = await response.json().catch(() => null);
    return payload?.error || payload?.message || `Ошибка ${response.status}`;
  }
  return await response.text() || `Ошибка ${response.status}`;
}

function setAuthMode(mode) {
  authMode = mode === 'register' ? 'register' : 'login';
  const registering = authMode === 'register';
  els.loginTab.classList.toggle('active', !registering);
  els.registerTab.classList.toggle('active', registering);
  els.loginTab.setAttribute('aria-selected', String(!registering));
  els.registerTab.setAttribute('aria-selected', String(registering));
  els.authTitle.textContent = registering ? 'Создайте аккаунт' : 'Войдите в аккаунт';
  els.authDescription.textContent = registering
    ? 'После регистрации ссылка на XML-фид будет храниться только в вашем аккаунте.'
    : 'Ваш XML-фид сохранится в аккаунте и будет доступен при следующем входе.';
  els.authSubmit.textContent = registering ? 'Зарегистрироваться' : 'Войти';
  els.authPassword.autocomplete = registering ? 'new-password' : 'current-password';
  els.authConfirmField.classList.toggle('hidden', !registering);
  els.authConfirm.classList.toggle('hidden', !registering);
  els.authConfirm.required = registering;
  els.authError.textContent = '';
}

function showAuth(message = '') {
  state.user = null;
  document.body.classList.remove('authenticated', 'auth-pending');
  els.accountEmail.textContent = '';
  els.authError.textContent = message;
  els.authPassword.value = '';
  els.authConfirm.value = '';
}

function showWorkspace(user) {
  state.user = user;
  document.body.classList.remove('auth-pending');
  document.body.classList.add('authenticated');
  els.accountEmail.textContent = user.email;
}

function resetWorkspace() {
  if (activeFeedOperation) {
    activeFeedOperation.controller.abort();
    clearTimeout(activeFeedOperation.timer);
    activeFeedOperation = null;
  }
  state.vehicles = [];
  state.filtered = [];
  state.selected = null;
  state.photoIndex = 0;
  state.priceOverride = null;
  state.ownerOverride = null;
  state.autotekaOverride = null;
  els.feedUrl.value = '';
  els.searchInput.value = '';
  renderStory();
  setEmptyCatalog();
}

async function initializeAuth() {
  try {
    const response = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      showAuth();
      return;
    }
    const payload = await response.json();
    showWorkspace(payload.user);
    if (payload.feedUrl) {
      els.feedUrl.value = payload.feedUrl;
      await loadXmlFromUrl(payload.feedUrl);
    }
  } catch {
    showAuth('Не удалось связаться с сервером. Обновите страницу.');
  }
}

function setLoading(message = 'Подключаем XML-фид', detail = 'Обычно это занимает несколько секунд') {
  els.catalogState.classList.remove('hidden');
  els.catalogState.innerHTML = `<span class="loader-ring"></span><strong>${message}</strong><small>${detail}</small>`;
  els.vehicleList.innerHTML = '';
}

function setEmptyCatalog() {
  els.catalogState.classList.remove('hidden');
  els.catalogState.innerHTML = '<span class="empty-feed-icon">+</span><strong>Добавьте XML-фид</strong><small>Вставьте ссылку MaxPoster или загрузите XML-файл</small>';
  els.vehicleList.innerHTML = '';
  els.vehicleCount.textContent = '0';
  els.feedStatus.textContent = 'Фид не загружен';
  els.statusDot.classList.remove('online');
}

function setCatalogError(message) {
  state.vehicles = [];
  state.filtered = [];
  state.selected = null;
  els.vehicleList.innerHTML = '';
  els.vehicleCount.textContent = '0';
  els.statusDot.classList.remove('online');
  renderStory();
  els.catalogState.classList.remove('hidden');
  els.catalogState.innerHTML = '<strong>Не получилось загрузить фид</strong><small></small>';
  els.catalogState.querySelector('small').textContent = message;
}

function renderCatalog() {
  els.vehicleCount.textContent = state.filtered.length;
  els.vehicleList.innerHTML = '';
  els.catalogState.classList.toggle('hidden', state.filtered.length > 0);

  if (!state.filtered.length) {
    els.catalogState.innerHTML = '<strong>Ничего не найдено</strong><small>Попробуйте изменить поисковый запрос</small>';
    return;
  }

  const fragment = document.createDocumentFragment();
  state.filtered.forEach((vehicle) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `vehicle-card ${state.selected?.id === vehicle.id ? 'active' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', state.selected?.id === vehicle.id ? 'true' : 'false');
    const badges = [
      vehicle.ownerCount === 1 ? '<i class="mini-tag">1 владелец</i>' : '',
      vehicle.greenAutoteka ? '<i class="mini-tag green">Автотека</i>' : '',
    ].join('');
    button.innerHTML = `
      <img src="${vehicle.pictures[0]}" alt="" loading="lazy" referrerpolicy="no-referrer" />
      <span class="vehicle-card-copy">
        <strong>${storyName(vehicle)}</strong>
        <span>${formatPrice(vehicle.price)}</span>
        <small>${badges || `<i class="mini-tag">${vehicleYear(vehicle) || `ID ${vehicle.id}`}</i>`}</small>
      </span>
      <span class="vehicle-card-arrow">›</span>`;
    button.addEventListener('click', () => selectVehicle(vehicle));
    fragment.appendChild(button);
  });
  els.vehicleList.appendChild(fragment);
}

function renderStory() {
  const vehicle = state.selected;
  els.storyPreview.className = `story theme-${state.theme}`;
  els.dealerLockup.classList.toggle('hidden', !state.dealer);
  els.dealerSign.textContent = state.dealer.slice(0, 1);
  els.storyDealer.textContent = state.dealer;
  const selectedPhoto = vehicle ? imageUrl(vehicle.pictures[state.photoIndex], true) : '';
  els.storyImage.hidden = !selectedPhoto;
  els.storyBackground.hidden = !selectedPhoto;
  if (selectedPhoto) {
    els.storyImage.src = selectedPhoto;
    els.storyBackground.src = selectedPhoto;
  } else {
    els.storyImage.removeAttribute('src');
    els.storyBackground.removeAttribute('src');
  }
  els.storyBackground.style.objectPosition = `center ${state.photoPosition}%`;
  els.storyImage.style.transform = `translateY(${(state.photoPosition - 50) * 0.55}px)`;
  els.storyTitle.textContent = storyName(vehicle);
  els.storyPrice.textContent = formatPrice(currentPrice());
  els.storyKicker.textContent = vehicle ? 'АВТОМОБИЛЬ С ПРОБЕГОМ' : 'СОЗДАЙТЕ СВОЮ ИСТОРИЮ';
  els.storySpecs.innerHTML = vehicleSpecs(vehicle).map((spec) => `<span>${spec}</span>`).join('');
  const badges = [];
  if (ownerEnabled()) badges.push('<span class="story-badge">1 владелец</span>');
  if (autotekaEnabled()) badges.push('<span class="story-badge">Зелёная Автотека</span>');
  els.storyBadges.innerHTML = badges.join('');
  els.photoCounter.textContent = vehicle ? `Фото ${state.photoIndex + 1} / ${vehicle.pictures.length}` : 'Фото 0 / 0';
  els.priceInput.value = currentPrice() ? formatNumber(currentPrice()) : '';
  els.ownerToggle.checked = ownerEnabled();
  els.autotekaToggle.checked = autotekaEnabled();
  els.ownerHint.textContent = vehicle?.ownerCount ? `В XML указано: ${vehicle.ownerCount}` : 'В XML нет значения';
  els.autotekaHint.textContent = vehicle?.greenAutoteka ? 'Найдено в данных XML' : 'В XML признак не найден';
}

function selectVehicle(vehicle) {
  state.selected = vehicle;
  state.photoIndex = 0;
  state.priceOverride = null;
  state.ownerOverride = null;
  state.autotekaOverride = null;
  renderCatalog();
  renderStory();
}

function validateFeedUrl(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error('Введите корректную ссылку на XML-фид.'); }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || (hostname !== 'maxposter.ru' && !hostname.endsWith('.maxposter.ru'))) {
    throw new Error('Разрешены только HTTPS-ссылки на XML-фиды maxposter.ru.');
  }
  return parsed.toString();
}

function beginFeedOperation() {
  if (activeFeedOperation) {
    activeFeedOperation.controller?.abort();
    clearTimeout(activeFeedOperation.timer);
  }
  const operation = {
    id: Symbol('feed-operation'),
    controller: new AbortController(),
    startedAt: Date.now(),
    timedOut: false,
    timer: null,
  };
  operation.timer = setTimeout(() => {
    operation.timedOut = true;
    operation.controller.abort();
  }, FEED_PROCESSING_TIMEOUT_MS);
  activeFeedOperation = operation;
  els.feedForm.setAttribute('aria-busy', 'true');
  return operation;
}

function finishFeedOperation(operation) {
  clearTimeout(operation.timer);
  if (activeFeedOperation === operation) {
    activeFeedOperation = null;
    els.feedForm.removeAttribute('aria-busy');
  }
}

function ensureOperationActive(operation) {
  if (activeFeedOperation !== operation) throw new DOMException('Обработка отменена.', 'AbortError');
  if (operation.timedOut || Date.now() - operation.startedAt >= FEED_PROCESSING_TIMEOUT_MS) {
    operation.timedOut = true;
    throw new DOMException('Превышено время обработки.', 'TimeoutError');
  }
}

function timeoutMessage() {
  return 'Фид не был обработан за 2 минуты. Обработка отменена — попробуйте ещё раз или проверьте размер и формат XML.';
}

async function loadXmlFromUrl(value) {
  let url;
  try { url = validateFeedUrl(value); }
  catch (error) {
    setCatalogError(error.message);
    els.feedStatus.textContent = 'Неверная ссылка';
    showToast(error.message, 'error');
    return;
  }

  const operation = beginFeedOperation();
  setLoading('Подключаем XML-фид', 'Если обработка займёт больше 2 минут, она будет отменена');
  els.feedStatus.textContent = 'Загружаем данные…';
  els.statusDot.classList.remove('online');
  try {
    const target = `/api/feed?url=${encodeURIComponent(url)}`;
    const response = await fetch(target, { signal: operation.controller.signal });
    ensureOperationActive(operation);
    if (response.status === 401) {
      showAuth('Сессия завершилась. Войдите снова.');
      throw new DOMException('Сессия завершилась.', 'AbortError');
    }
    if (!response.ok) throw new Error(await responseMessage(response));
    const contentLength = Number(response.headers.get('Content-Length')) || 0;
    if (contentLength > MAX_FEED_SIZE_BYTES) throw new Error('Фид слишком большой. Максимальный размер — 20 МБ.');
    const xmlText = await response.text();
    ensureOperationActive(operation);
    applyXml(xmlText, url, operation);
  } catch (error) {
    if (activeFeedOperation !== operation) return;
    const isTimeout = operation.timedOut || error.name === 'TimeoutError';
    const hint = location.protocol === 'file:'
      ? 'Запустите файл start.cmd или загрузите XML с компьютера.'
      : isTimeout ? timeoutMessage() : (error.name === 'AbortError' ? 'Обработка фида отменена.' : error.message);
    setCatalogError(hint);
    els.feedStatus.textContent = isTimeout ? 'Превышено 2 минуты' : 'Ошибка загрузки';
    showToast(hint, 'error');
  } finally {
    finishFeedOperation(operation);
  }
}

function applyXml(xmlText, sourceLabel = 'XML-файл', operation = null) {
  if (operation) ensureOperationActive(operation);
  const vehicles = parseFeed(xmlText);
  if (operation) ensureOperationActive(operation);
  state.vehicles = vehicles;
  state.filtered = vehicles;
  state.selected = null;
  els.searchInput.value = '';
  els.feedStatus.textContent = `${vehicles.length} авто · ${sourceLabel.includes('4179') ? 'MaxPoster 4179' : 'XML загружен'}`;
  els.statusDot.classList.add('online');
  if (vehicles.length) selectVehicle(vehicles[0]);
  else renderCatalog();
  showToast(`Загружено автомобилей: ${vehicles.length}`);
}

els.loginTab.addEventListener('click', () => setAuthMode('login'));
els.registerTab.addEventListener('click', () => setAuthMode('register'));

els.authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;
  if (authMode === 'register' && password !== els.authConfirm.value) {
    els.authError.textContent = 'Пароли не совпадают.';
    els.authConfirm.focus();
    return;
  }

  els.authError.textContent = '';
  els.authSubmit.disabled = true;
  els.authSubmit.textContent = authMode === 'register' ? 'Создаём аккаунт…' : 'Входим…';
  try {
    const response = await fetch(`/api/auth/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) throw new Error(await responseMessage(response));
    const payload = await response.json();
    resetWorkspace();
    showWorkspace(payload.user);
    els.authForm.reset();
    setAuthMode('login');
    if (payload.feedUrl) {
      els.feedUrl.value = payload.feedUrl;
      await loadXmlFromUrl(payload.feedUrl);
    }
  } catch (error) {
    const message = error instanceof TypeError && /fetch/i.test(error.message)
      ? 'Нет связи с сервером. Перезапустите StoryDrive и обновите страницу.'
      : (error.message || 'Не удалось выполнить вход.');
    els.authError.textContent = message;
  } finally {
    els.authSubmit.disabled = false;
    els.authSubmit.textContent = authMode === 'register' ? 'Зарегистрироваться' : 'Войти';
  }
});

els.logoutButton.addEventListener('click', async () => {
  els.logoutButton.disabled = true;
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: { Accept: 'application/json' } });
  } finally {
    resetWorkspace();
    showAuth();
    els.logoutButton.disabled = false;
  }
});

els.clearSavedFeed.addEventListener('click', async () => {
  if (!state.user) return;
  els.clearSavedFeed.disabled = true;
  try {
    const response = await fetch('/api/user/feed', { method: 'DELETE', headers: { Accept: 'application/json' } });
    if (response.status === 401) {
      resetWorkspace();
      showAuth('Сессия завершилась. Войдите снова.');
      return;
    }
    if (!response.ok) throw new Error(await responseMessage(response));
    resetWorkspace();
    showToast('Сохранённый фид удалён');
  } catch (error) {
    showToast(error.message || 'Не удалось удалить сохранённый фид', 'error');
  } finally {
    els.clearSavedFeed.disabled = false;
  }
});

els.feedForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const url = els.feedUrl.value.trim();
  if (url) loadXmlFromUrl(url);
});

els.feedFile.addEventListener('change', async () => {
  const file = els.feedFile.files?.[0];
  if (!file) return;
  if (!/\.xml$/i.test(file.name) && !/^(?:application|text)\/xml$/i.test(file.type)) {
    const message = 'Выберите XML-файл с расширением .xml.';
    setCatalogError(message);
    els.feedStatus.textContent = 'Неверный формат файла';
    showToast(message, 'error');
    els.feedFile.value = '';
    return;
  }
  if (file.size > MAX_FEED_SIZE_BYTES) {
    const message = 'Фид слишком большой. Максимальный размер — 20 МБ.';
    setCatalogError(message);
    els.feedStatus.textContent = 'Файл слишком большой';
    showToast(message, 'error');
    els.feedFile.value = '';
    return;
  }

  const operation = beginFeedOperation();
  setLoading('Обрабатываем XML-файл', 'Операция будет отменена через 2 минуты');
  els.feedStatus.textContent = 'Обрабатываем файл…';
  try {
    const xmlText = await Promise.race([
      file.text(),
      new Promise((_, reject) => {
        operation.controller.signal.addEventListener('abort', () => reject(new DOMException('Превышено время обработки.', 'TimeoutError')), { once: true });
      }),
    ]);
    ensureOperationActive(operation);
    applyXml(xmlText, file.name, operation);
  } catch (error) {
    if (activeFeedOperation !== operation) return;
    const isTimeout = operation.timedOut || error.name === 'TimeoutError';
    const message = isTimeout ? timeoutMessage() : error.message;
    setCatalogError(message);
    els.feedStatus.textContent = isTimeout ? 'Превышено 2 минуты' : 'Ошибка формата XML';
    showToast(message, 'error');
  } finally {
    finishFeedOperation(operation);
    els.feedFile.value = '';
  }
});

els.searchInput.addEventListener('input', () => {
  const query = els.searchInput.value.trim().toLocaleLowerCase('ru');
  state.filtered = state.vehicles.filter((vehicle) => `${vehicle.vendor} ${vehicle.model} ${vehicle.id}`.toLocaleLowerCase('ru').includes(query));
  renderCatalog();
});

function movePhoto(direction) {
  if (!state.selected?.pictures.length) return;
  state.photoIndex = (state.photoIndex + direction + state.selected.pictures.length) % state.selected.pictures.length;
  renderStory();
}
els.prevPhoto.addEventListener('click', () => movePhoto(-1));
els.nextPhoto.addEventListener('click', () => movePhoto(1));

els.priceInput.addEventListener('input', () => {
  const value = Number(els.priceInput.value.replace(/\D/g, '')) || 0;
  state.priceOverride = value;
  els.storyPrice.textContent = formatPrice(value);
});
els.priceInput.addEventListener('blur', () => { els.priceInput.value = currentPrice() ? formatNumber(currentPrice()) : ''; });
els.resetPrice.addEventListener('click', () => { state.priceOverride = null; renderStory(); });
els.ownerToggle.addEventListener('change', () => { state.ownerOverride = els.ownerToggle.checked; renderStory(); });
els.autotekaToggle.addEventListener('change', () => { state.autotekaOverride = els.autotekaToggle.checked; renderStory(); });
els.photoPosition.addEventListener('input', () => { state.photoPosition = Number(els.photoPosition.value); renderStory(); });
els.dealerInput.addEventListener('input', () => { state.dealer = els.dealerInput.value.trim().toUpperCase(); renderStory(); });

els.themeGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-theme]');
  if (!button) return;
  state.theme = button.dataset.theme;
  els.themeGrid.querySelectorAll('.theme-option').forEach((option) => option.classList.toggle('active', option === button));
  renderStory();
});

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawCover(ctx, image, width, height, positionY = 50) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawW = image.naturalWidth * scale;
  const drawH = image.naturalHeight * scale;
  const x = (width - drawW) / 2;
  const overflow = drawH - height;
  const y = -overflow * (positionY / 100);
  ctx.drawImage(image, x, y, drawW, drawH);
}

function drawContain(ctx, image, x, y, width, height) {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const drawW = image.naturalWidth * scale;
  const drawH = image.naturalHeight * scale;
  ctx.drawImage(image, x + (width - drawW) / 2, y + (height - drawH) / 2, drawW, drawH);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Не удалось загрузить выбранную фотографию'));
    image.src = url;
  });
}

function wrapLines(ctx, content, maxWidth, maxLines = 3) {
  const words = content.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[.,]$/, '')}…`;
    return kept;
  }
  return lines;
}

function drawPill(ctx, label, x, y, accent) {
  ctx.font = '800 27px Manrope, sans-serif';
  const width = ctx.measureText(label).width + 108;
  roundedRect(ctx, x, y, width, 70, 35);
  ctx.fillStyle = 'rgba(255,255,255,.15)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + 36, y + 35, 17, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.fillStyle = state.theme === 'lime' ? '#111' : '#fff';
  ctx.font = '800 20px Manrope, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('✓', x + 36, y + 42);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = '800 27px Manrope, sans-serif';
  ctx.fillText(label, x + 67, y + 45);
  return width;
}

async function exportStory() {
  if (!state.selected) { showToast('Сначала выберите автомобиль', 'error'); return; }
  const buttons = [els.exportButton, els.exportTop, els.saveStoryButton];
  buttons.forEach((button) => { button.disabled = true; });
  els.exportButton.textContent = 'Готовим изображение…';
  try {
    await document.fonts?.ready;
    const canvas = els.exportCanvas;
    const ctx = canvas.getContext('2d');
    const colors = { violet: '#8a5cff', lime: '#a8f000', orange: '#ff6d36', red: '#e31c3d' };
    const accent = colors[state.theme];
    const photo = state.selected.pictures[state.photoIndex];
    const image = await loadImage(imageUrl(photo, true));

    ctx.clearRect(0, 0, 1080, 1920);
    ctx.fillStyle = '#0b0b0e';
    ctx.fillRect(0, 0, 1080, 1920);
    ctx.save();
    ctx.filter = 'blur(38px) saturate(.82)';
    drawCover(ctx, image, 1080, 1920, state.photoPosition);
    ctx.restore();
    ctx.fillStyle = 'rgba(6,6,9,.30)';
    ctx.fillRect(0, 0, 1080, 1920);

    const photoY = 200 + (state.photoPosition - 50) * 1.25;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.36)';
    ctx.shadowBlur = 55;
    ctx.shadowOffsetY = 28;
    roundedRect(ctx, 44, photoY, 992, 820, 54);
    ctx.fillStyle = 'rgba(8,8,11,.40)';
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundedRect(ctx, 44, photoY, 992, 820, 54);
    ctx.clip();
    drawContain(ctx, image, 44, photoY, 992, 820);
    ctx.restore();
    roundedRect(ctx, 44, photoY, 992, 820, 54);
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.lineWidth = 3;
    ctx.stroke();

    const gradient = ctx.createLinearGradient(0, 0, 0, 1920);
    gradient.addColorStop(0, 'rgba(5,5,8,.58)');
    gradient.addColorStop(.27, 'rgba(5,5,8,.03)');
    gradient.addColorStop(.49, 'rgba(5,5,8,.18)');
    gradient.addColorStop(.70, 'rgba(5,5,8,.80)');
    gradient.addColorStop(.84, 'rgba(7,7,10,.97)');
    gradient.addColorStop(1, '#07070a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1080, 1920);

    if (state.dealer) {
      roundedRect(ctx, 66, 64, 72, 72, 20);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.fillStyle = state.theme === 'lime' ? '#111' : '#fff';
      ctx.font = '700 36px Unbounded, Manrope, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(state.dealer[0], 102, 112);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff';
      ctx.font = '700 28px Unbounded, Manrope, sans-serif';
      ctx.fillText(state.dealer, 158, 94);
    }
    roundedRect(ctx, 819, 74, 195, 51, 26);
    ctx.fillStyle = 'rgba(8,8,12,.24)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.48)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '800 16px Manrope, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('В НАЛИЧИИ', 916, 106);
    ctx.textAlign = 'left';

    let y = 1230;
    let pillX = 68;
    if (ownerEnabled()) pillX += drawPill(ctx, '1 владелец', pillX, y, accent) + 14;
    if (autotekaEnabled()) drawPill(ctx, 'Зелёная Автотека', pillX, y, accent);
    y += ownerEnabled() || autotekaEnabled() ? 108 : 67;

    ctx.fillStyle = accent;
    ctx.font = '800 20px Manrope, sans-serif';
    ctx.fillText('АВТОМОБИЛЬ С ПРОБЕГОМ', 68, y);
    y += 34;
    ctx.fillStyle = '#fff';
    ctx.font = '700 68px Unbounded, Manrope, sans-serif';
    const titleLines = wrapLines(ctx, storyName(state.selected).toUpperCase(), 940, 2);
    titleLines.forEach((line, index) => ctx.fillText(line, 68, y + 74 + index * 78));
    y += titleLines.length * 78 + 85;

    ctx.font = '600 24px Manrope, sans-serif';
    let specX = 68;
    vehicleSpecs(state.selected).forEach((spec, index) => {
      if (index) {
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(specX + 10, y - 8, 4, 0, Math.PI * 2);
        ctx.fill();
        specX += 30;
      }
      ctx.fillStyle = '#c7c7ce';
      ctx.fillText(spec, specX, y);
      specX += ctx.measureText(spec).width + 24;
    });
    y += 52;

    ctx.strokeStyle = 'rgba(255,255,255,.20)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(68, y); ctx.lineTo(1012, y); ctx.stroke();
    ctx.fillStyle = '#8f8f99';
    ctx.font = '700 16px Manrope, sans-serif';
    ctx.fillText('СТОИМОСТЬ', 68, y + 38);
    ctx.fillStyle = '#fff';
    ctx.font = '700 66px Unbounded, Manrope, sans-serif';
    ctx.fillText(formatPrice(currentPrice()), 68, y + 107);

    ctx.beginPath();
    ctx.arc(949, y + 70, 58, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.fillStyle = state.theme === 'lime' ? '#111' : '#fff';
    ctx.font = '500 50px Manrope, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('↗', 949, y + 87);
    ctx.textAlign = 'left';

    const footerY = 1853;
    ctx.strokeStyle = 'rgba(255,255,255,.20)';
    ctx.beginPath(); ctx.moveTo(68, footerY - 33); ctx.lineTo(1012, footerY - 33); ctx.stroke();
    ctx.fillStyle = '#93939c';
    ctx.font = '600 18px Manrope, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Свайп, чтобы узнать больше', 1012, footerY);
    ctx.textAlign = 'left';

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png', 1));
    if (!blob) throw new Error('Браузер не смог создать PNG');
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${state.selected.vendor}-${state.selected.id}-story.png`.replace(/[^a-zа-яё0-9.-]+/gi, '-');
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    showToast('Сторис сохранён в PNG');
  } catch (error) {
    showToast(error.message || 'Не удалось экспортировать сторис', 'error');
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    els.exportButton.textContent = 'Скачать сторис';
  }
}

els.exportButton.addEventListener('click', exportStory);
els.exportTop.addEventListener('click', exportStory);
els.saveStoryButton.addEventListener('click', exportStory);

renderStory();
setEmptyCatalog();
setAuthMode('login');
initializeAuth();
