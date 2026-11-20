(() => {
  if (!globalThis.chrome?.runtime?.id || window.__QA_LOCAL_PLAYBACK_INITIALIZED__) return;
  window.__QA_LOCAL_PLAYBACK_INITIALIZED__ = true;

  const isGenericLocator = value =>
    typeof value !== 'string' || !value.trim() || /^(element|target element|unknown|locator|body)$/i.test(value.trim());

  function postToApp(type, payload) {
    window.postMessage({ type, ...payload }, '*');
  }

  function sendAppCommand(type, detail) {
    chrome.runtime.sendMessage({ type, ...detail }, response => {
      const error = chrome.runtime.lastError;
      postToApp('AUTOMATIQA_LOCAL_PLAYBACK_ACK', {
        action: type,
        success: !error && Boolean(response?.success),
        playbackId: detail.playbackId,
        error: error?.message || response?.error
      });
    });
  }

  window.addEventListener('message', event => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'AUTOMATIQA_START_LOCAL_PLAYBACK') {
      sendAppCommand('START_LOCAL_PLAYBACK', event.data);
    } else if (event.data.type === 'AUTOMATIQA_PAUSE_LOCAL_PLAYBACK') {
      sendAppCommand('PAUSE_LOCAL_PLAYBACK', event.data);
    } else if (event.data.type === 'AUTOMATIQA_RESUME_LOCAL_PLAYBACK') {
      sendAppCommand('RESUME_LOCAL_PLAYBACK', event.data);
    } else if (event.data.type === 'AUTOMATIQA_STOP_LOCAL_PLAYBACK') {
      sendAppCommand('STOP_LOCAL_PLAYBACK', event.data);
    }
  });

  function querySelectorSafe(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function findStructuredLocator(locator) {
    if (!locator || typeof locator !== 'object') return null;
    const utils = window.QA_RECORDER_UTILS;
    const value = String(locator.value || '');
    const name = String(locator.name || value).trim();
    const exact = locator.exact !== false;
    const all = Array.from(document.querySelectorAll('*'));
    const matchText = text => exact ? text === name : text.includes(name);

    switch (locator.strategy) {
      case 'id':
        return value ? document.getElementById(value) : null;
      case 'testid':
        return querySelectorSafe(`[${locator.testIdAttribute || 'data-testid'}="${CSS.escape(value || name)}"]`);
      case 'placeholder':
        return Array.from(document.querySelectorAll('[placeholder]')).find(el => el.getAttribute('placeholder') === name) || null;
      case 'label': {
        const label = Array.from(document.querySelectorAll('label')).find(el => matchText((el.innerText || el.textContent || '').trim()));
        if (!label) return null;
        if (label.htmlFor) return document.getElementById(label.htmlFor) || label;
        return label.querySelector('input,textarea,select') || label;
      }
      case 'name':
        return querySelectorSafe(`[name="${CSS.escape(value || name)}"]`);
      case 'href':
        return querySelectorSafe(`a[href="${CSS.escape(value || name)}"]`);
      case 'role':
        return all.find(el =>
          (!locator.role || (utils?.getComputedRole?.(el) || el.getAttribute('role')) === locator.role) &&
          (!name || (utils?.getAccessibleName?.(el) || '').trim() === name)
        ) || null;
      case 'text':
        return all.find(el => matchText((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())) || null;
      case 'xpath': {
        try {
          return document.evaluate(value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        } catch {
          return null;
        }
      }
      case 'css':
        return querySelectorSafe(value);
      default:
        return null;
    }
  }

  function resolveElement(step) {
    const locator = step.locator || {};
    const primary = locator.primary || {};
    const structured = step.structuredLocator || locator.structuredLocator || primary.structuredLocator;
    const structuredElement = findStructuredLocator(structured);
    if (structuredElement) return structuredElement;

    const candidates = [primary, ...(Array.isArray(locator.alternatives) ? locator.alternatives : [])];
    for (const candidate of candidates) {
      if (!candidate || isGenericLocator(candidate.value)) continue;
      if (candidate.type === 'id') {
        const element = document.getElementById(candidate.value);
        if (element) return element;
      } else if (candidate.type === 'name') {
        const element = querySelectorSafe(`[name="${CSS.escape(candidate.value)}"]`);
        if (element) return element;
      } else if (candidate.type === 'role') {
        const found = findStructuredLocator({ strategy: 'role', role: candidate.role, name: candidate.value });
        if (found) return found;
      } else if (candidate.type === 'text') {
        const found = findStructuredLocator({ strategy: 'text', value: candidate.value });
        if (found) return found;
      } else if (candidate.type === 'placeholder') {
        const found = findStructuredLocator({ strategy: 'placeholder', value: candidate.value });
        if (found) return found;
      } else if (candidate.type === 'xpath' || String(candidate.value).startsWith('xpath=')) {
        try {
          const xpath = String(candidate.value).replace(/^xpath=/, '');
          const found = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (found) return found;
        } catch {}
      } else {
        const found = querySelectorSafe(candidate.value);
        if (found) return found;
      }
    }
    return null;
  }

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function waitForElement(step, timeoutMs = 10000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const element = resolveElement(step);
      if (element) return element;
      await delay(100);
    }
    throw new Error(`Could not find locator: ${step.locator?.primary?.value || step.elementName || 'unknown element'}`);
  }

  function setInputValue(element, value) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (element.isContentEditable) {
      element.textContent = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return;
    }
    throw new Error('The locator did not resolve to a fillable input.');
  }

  async function executeStep(step) {
    const action = String(step.action || '').toLowerCase();
    if (action === 'wait') {
      const duration = Math.max(0, Math.min(30000, Number(step.value || step.duration) || 500));
      await delay(duration);
      return;
    }
    if (action === 'scroll') {
      const dx = Number(step.deltaX || step.scrollX || step.x || 0);
      const dy = Number(step.deltaY || step.scrollY || step.y || 500);
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      return;
    }

    const element = await waitForElement(step);
    if (action === 'click' || action === 'submit') {
      element.click();
    } else if (action === 'dblclick') {
      element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    } else if (action === 'fill' || action === 'type') {
      setInputValue(element, String(step.value || ''));
    } else if (action === 'select' || action === 'selectoption') {
      if (!(element instanceof HTMLSelectElement)) throw new Error('The locator did not resolve to a select element.');
      element.value = String(step.value || '');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (action === 'check' || action === 'uncheck') {
      if (!(element instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(element.type)) {
        throw new Error('The locator did not resolve to a checkbox or radio input.');
      }
      element.checked = action === 'check';
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (action === 'hover' || action === 'focus') {
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
      element.focus?.();
    } else if (action === 'blur') {
      element.blur?.();
    } else if (action === 'press') {
      const key = String(step.value || 'Enter');
      element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      if (key === 'Enter' && element.form) element.form.requestSubmit();
    } else {
      throw new Error(`Local browser playback does not support the "${action || 'unknown'}" action yet.`);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message) return false;
    if (message.type === 'LOCAL_PLAYBACK_EVENT') {
      postToApp('AUTOMATIQA_LOCAL_PLAYBACK_EVENT', message.event || {});
      return false;
    }
    if (message.type !== 'LOCAL_PLAYBACK_STEP') return false;

    const startedAt = Date.now();
    executeStep(message.step)
      .then(() => sendResponse({
        success: true,
        duration: Date.now() - startedAt,
        url: window.location.href,
        pageTitle: document.title
      }))
      .catch(error => sendResponse({
        success: false,
        duration: Date.now() - startedAt,
        error: error?.message || String(error),
        url: window.location.href,
        pageTitle: document.title
      }));
    return true;
  });
})();
