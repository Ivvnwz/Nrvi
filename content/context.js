(() => {
  if (window.__nrviContextLoaded) return;
  window.__nrviContextLoaded = true;

  const ACTION_SELECTOR = 'button, a[href], [role="button"], input[type="submit"], input[type="button"]';
  const FIELD_SELECTOR = 'input:not([type="hidden"]), textarea, select';
  const MAX_ACTIONS = 60;
  const MAX_FIELDS = 30;

  const registry = new Map();

  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

  const isVisible = element => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  const label = element => {
    const explicit = element.getAttribute('aria-label') || element.getAttribute('title');
    if (explicit) return clean(explicit);
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const descriptor = element.getAttribute('placeholder') || element.getAttribute('name') || element.id;
      if (element.getAttribute('type') === 'password') return clean(descriptor);
      return clean(element.value || descriptor);
    }
    return clean(element.innerText || element.textContent);
  };

  window.nrviContext = () => {
    registry.clear();

    const actionElements = [];
    for (const element of document.querySelectorAll(ACTION_SELECTOR)) {
      if (actionElements.length >= MAX_ACTIONS) break;
      if (!isVisible(element)) continue;
      if (!label(element)) continue;
      actionElements.push(element);
    }

    const fieldElements = [];
    for (const element of document.querySelectorAll(FIELD_SELECTOR)) {
      if (fieldElements.length >= MAX_FIELDS) break;
      if (!isVisible(element)) continue;
      fieldElements.push(element);
    }

    const actions = actionElements.map((element, index) => {
      const id = `action-${index}`;
      registry.set(id, element);
      return { id, kind: element.matches('a[href]') ? 'link' : 'button', label: label(element) };
    });

    const fields = fieldElements.map((element, index) => {
      const id = `field-${index}`;
      registry.set(id, element);
      return {
        id,
        label: label(element),
        type: element.getAttribute('type') || element.tagName.toLowerCase(),
        required: Boolean(element.required)
      };
    });

    return {
      url: location.href,
      title: clean(document.title),
      headings: [...document.querySelectorAll('h1, h2, h3')].filter(isVisible).map(label).filter(Boolean).slice(0, 30),
      description: clean(document.querySelector('meta[name="description"]')?.content || document.querySelector('main, article')?.innerText).slice(0, 5000),
      actions,
      fields,
      text: clean(document.querySelector('main, article, body')?.innerText).slice(0, 12000)
    };
  };

  window.nrviResolve = id => {
    const element = registry.get(id);
    return element && element.isConnected ? element : null;
  };
})();
