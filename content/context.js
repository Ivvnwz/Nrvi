(() => {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const label = element => clean(
    element.getAttribute('aria-label') ||
    element.getAttribute('title') ||
    element.innerText ||
    element.value ||
    element.placeholder ||
    element.name ||
    element.id
  );

  window.nrviContext = () => {
    const actions = [...document.querySelectorAll('button, a[href], [role="button"], input[type="submit"], input[type="button"]')]
      .filter(visible)
      .slice(0, 60)
      .map((element, index) => ({
        id: `action-${index}`,
        kind: element.matches('a[href]') ? 'link' : 'button',
        label: label(element)
      }))
      .filter(item => item.label);
    const fields = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')]
      .filter(visible)
      .slice(0, 30)
      .map((element, index) => ({
        id: `field-${index}`,
        label: label(element),
        type: element.type || element.tagName.toLowerCase(),
        required: Boolean(element.required)
      }));
    return {
      url: location.href,
      title: clean(document.title),
      headings: [...document.querySelectorAll('h1, h2, h3')].filter(visible).slice(0, 30).map(label),
      description: clean(document.querySelector('meta[name="description"]')?.content || document.querySelector('main, article')?.innerText).slice(0, 5000),
      actions,
      fields,
      text: clean(document.querySelector('main, article, body')?.innerText).slice(0, 12000)
    };
  };
})();
