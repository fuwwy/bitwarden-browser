document.addEventListener('DOMContentLoaded', _ => {
    if (window.location.hostname.indexOf('vault.bitwarden.com') > -1) {
        return;
    }

    const inIframe = isInIframe();
    const inputSelector = 'input:not([type]),input[type="email"],input[type="password"],input[type="text"]';
    const oldPassRegex = /(?:existing|old|curr|former)(?=.*pass)|(?<=pass.*)(?:existing|old|curr|former)/;
    const newPassRegex = /(?:new)(?=.*pass)|(?<=pass.*)(?:new)/;
    let activeIcons: {icon: HTMLElement, input: HTMLElement}[] = [];
    const activeOverlays: {overlay: HTMLElement, icon: {icon: HTMLElement, input: HTMLElement}}[] = [];

    let barType: string = null;
    let disabledAddLoginNotification = false;
    let disabledChangedPasswordNotification = false;
    let cipherData = { ciphers: 0, usernameCiphers: 0, passwordCiphers: 0 };

    chrome.storage.local.get('neverDomains', (ndObj: any) => {
        const domains = ndObj.neverDomains;
        if (domains != null && domains.hasOwnProperty(window.location.hostname)) {
            return;
        }

        chrome.storage.local.get(['disableAddLoginNotification', 'disableChangedPasswordNotification'], items => {
            disabledAddLoginNotification = items.disableAddLoginNotification === true;
            disabledChangedPasswordNotification = items.disableChangedPasswordNotification === true;
            if (!disabledAddLoginNotification || !disabledChangedPasswordNotification) {
                startTrackingFormSubmissions();
                sendPlatformMessage({command: 'requestAvailableCiphers'});
            }
        });
    });

    chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: Function) => {
        processMessages(msg, sendResponse);
    });

    function processMessages(msg: any, sendResponse: Function) {
        if (msg.command === 'openNotificationBar') {
            if (inIframe) {
                return;
            }
            closeExistingAndOpenBar(msg.data.type, msg.data.typeData);
            sendResponse();
            return true;
        } else if (msg.command === 'closeNotificationBar') {
            if (inIframe) {
                return;
            }
            closeBar(true);
            sendResponse();
            return true;
        } else if (msg.command === 'adjustNotificationBar') {
            if (inIframe) {
                return;
            }
            adjustBar(msg.data);
            sendResponse();
            return true;
        } else if (msg.command === 'closeOverlays') {
            if (inIframe) {
                return;
            }
            closeAllOverlays();
        } else if (msg.command === 'availableCiphers') {
            if (inIframe) {
                return;
            }
            cipherData = msg.data;
            startTrackingPageChanges();
        }
    }

    function startTrackingFormSubmissions() {
        document.addEventListener('submit', (e: UIEvent) => {
            startRequestListener(e.target as HTMLElement);
            sendPlatformMessage({
                command: 'formSubmission',
                data: createFormData({formChild: e.target as HTMLElement}),
            });
        });

        document.addEventListener('mouseup', (e: MouseEvent) => {
            const targetNode = e.target as HTMLElement;
            if (canBeSubmitElement(targetNode))
                startRequestListener(targetNode);
        });

        document.addEventListener('keydown', (e: KeyboardEvent) => {
            const key = e.key || e.keyCode;
            if (key === 'Enter' || key === 13) {
                startRequestListener(e.target as HTMLElement);
            }
        });

        function hook() {
            let requestCounter = 0;

            const xmlSendOriginalMethod = XMLHttpRequest.prototype.send;
            const xmlSendProxy = new Proxy(xmlSendOriginalMethod, {
                apply: (target, receiver, args) => {
                    if (args[0] && (typeof args[0] === 'string' || typeof args[0] === 'object')) {
                        const data = typeof args[0] === 'object' ? JSON.stringify(args[0]) : args[0];
                        const reqId = ++requestCounter;
                        window.dispatchEvent(new CustomEvent('bw-request-start', {
                            detail: {
                                data: data,
                                reqId: reqId,
                            },
                        }));
                        receiver.addEventListener('loadend', () => {
                            window.dispatchEvent(new CustomEvent('bw-request-end', {
                                detail: {
                                    status: receiver.status,
                                    reqId: reqId,
                                },
                            }));
                        });
                    }
                    return target.apply(receiver, args);
                },
            });
            XMLHttpRequest.prototype.send = xmlSendProxy;

            const fetchOriginalMethod = fetch;
            const fetchProxy = new Proxy(fetchOriginalMethod, {
                apply: (target, receiver, args) => {
                    const response = target.apply(receiver, args);
                    if (args[0] && (typeof args[0] === 'string' || typeof args[0] === 'object')) {
                        const data = typeof args[0] === 'object' ? JSON.stringify(args[0]) : args[0];
                        const reqId = ++requestCounter;
                        window.dispatchEvent(new CustomEvent('bw-request-start', {
                            detail: {
                                data: data,
                                reqId: reqId,
                            },
                        }));
                        const callback = (res: any) => {
                            window.dispatchEvent(new CustomEvent('bw-request-end', {
                                detail: {
                                    status: res && res.status,
                                    reqId: reqId,
                                },
                            }));
                        };
                        response.then(callback).catch(callback);
                    }
                    return response;
                },
            });
            // @ts-ignore
            fetch = fetchProxy;
        }
        const hookScript = hook.toString() + 'hook();';
        const scriptElement = document.createElement('script');
        scriptElement.appendChild(document.createTextNode(hookScript));
        document.documentElement.appendChild(scriptElement);
        document.documentElement.removeChild(scriptElement);
    }


    function canBeSubmitElement(el: HTMLElement) {
        if (el.nodeName === 'TEXTAREA' || el.nodeName === 'SELECT') return false;
        if (el.nodeName === 'INPUT')
          return (el as HTMLInputElement).type === 'button' || (el as HTMLInputElement).type === 'submit';
        return true;
    }

    function createFormData(data: {formChild: HTMLElement, formElement?: HTMLElement}) {
        data.formElement = findFormElement(data.formChild);
        if (!data.formElement) {
            // Fallback to trying to find form in entire page
            const passwordField = document.querySelector('input[type=password]') as HTMLElement;
            if (passwordField) data.formElement = findFormElement(passwordField);
        }

        const formFields = Array.from((data.formElement || document.body).querySelectorAll(inputSelector) as NodeListOf<HTMLInputElement>)
            .filter(input => input.value && input.value.length > 0 && isVisible(input))
            .map(input => {
                return {
                    type: input.type,
                    value: input.value,
                    attributes: Array.from(input.attributes).map(attr => attr.name + '-' + attr.value).join(','),
                };
            });

        return {
            url: document.URL,
            fields: formFields,
        };
    }

    function findFormElement(element: HTMLElement) {
        while (element) {
            if (element.nodeName === 'FORM') return element;
            element = element.parentElement;
        }
        return null;
    }

    function isVisible(element: HTMLElement) {
        return element.offsetHeight || element.offsetWidth || element.getClientRects().length;
    }

    const requestListeners: any[] = [];
    function startRequestListener(formChild: HTMLElement) {
        const formData = createFormData({formChild: formChild});
        requestListeners.forEach(listener => window.removeEventListener('bw-request-start', listener));

        const eventListener = (event: any) => {
            if (!event.detail || !event.detail.data) return;
            const requestData = decodeURIComponent(event.detail.data);
            const isDataPresent = formData.fields.some(field => requestData.includes(field.value) || field.value.includes(requestData));
            if (!isDataPresent) return;

            window.removeEventListener('bw-request-start', eventListener);
            const endEventListener = (endEvent: any) => {
                if (endEvent.detail.reqId !== event.detail.reqId) return;
                window.removeEventListener('bw-request-end', endEventListener);
                if (endEvent.detail.status >= 200 && endEvent.detail.status < 300) {
                    sendPlatformMessage({
                        command: 'formSubmission',
                        data: formData,
                    });
                }
            };
            window.addEventListener('bw-request-end', endEventListener);
        };
        window.addEventListener('bw-request-start', eventListener);
        requestListeners.push(eventListener);
    }

    function startTrackingPageChanges() {
        let formElementCount = document.querySelectorAll('form,input').length;
        document.addEventListener('click', (e: MouseEvent) => {
            const newFormElementCount = document.querySelectorAll('form,input').length;
            if (formElementCount !== newFormElementCount) {
                formElementCount = newFormElementCount;
                setTimeout(() => createIcons(), 500);
            }
            if (activeOverlays.length > 0 && !(e.target as HTMLElement).classList.contains('bitwarden')) closeAllOverlays();
        });

        const mutationObserver = new window.MutationObserver(mutations => {
            setTimeout(() => {
                const haveInputsChanged = mutations.some(mutation => {
                    return [...mutation.addedNodes, ...mutation.removedNodes].some(node => {
                        const changedNode = node as HTMLElement;
                        return changedNode.tagName && (changedNode.tagName === 'INPUT' || changedNode.getElementsByTagName('INPUT'));
                    });
                });
                if (haveInputsChanged) createIcons();
            });
        });
        mutationObserver.observe(document, {
            childList: true,
            subtree: true,
        });

        setTimeout(() => createIcons(), 100);
        setInterval(() => checkPositions(), 200);
    }

    function hasAttribute(el: HTMLElement, attr: string) {
        return Array.from(el.attributes).some(att => att.name.toLowerCase().includes(attr) || att.value.toLowerCase().includes(attr));
    }

    function isValidField(input: HTMLInputElement) {
        if (!input || !input.type || !isVisible(input) || window.getComputedStyle(input).visibility === 'hidden') return false;

        const fieldType = input.type.toLowerCase();
        if (!['email', 'text', 'password'].some(type => fieldType.includes(type))) return false;

        if (fieldType === 'search' || hasAttribute(input, 'search')) return false;
        return true;
    }

    function isUsernameField(field: HTMLInputElement) {
        const fieldType = field.type.toLowerCase();
        return fieldType === 'email' || fieldType === 'text';
    }

    function createIcons() {
        const inputs = Array.from(document.getElementsByTagName('input'));

        inputs.filter(isValidField).forEach(input => {
            if (input.form) {
                if (hasAttribute(input.form, 'search')) return;

                const formInputs = Array.from(input.form.getElementsByTagName('input'));
                const usernameFields = formInputs.filter(field => isUsernameField(field) && isValidField(field));
                const passwordFields = formInputs.filter(field => field.type.toLowerCase() === 'password' && isValidField(field));
                const newPwFields = passwordFields.filter(field => field.autocomplete.includes('new') || field.id.match(newPassRegex));

                if (input.type.toLowerCase() === 'text' && passwordFields.length === 0) return;

                const isSignupOrCpwForm = passwordFields.length > 1 || usernameFields.length > 1 || newPwFields.length > 0 ||
                    hasAttribute(input, 'signup') || hasAttribute(input.form, 'signup');

                if (!isSignupOrCpwForm) {
                    placeIcon(input, passwordFields.includes(input) ? 'password' : 'username');
                } else {
                    const oldPwFields = passwordFields.filter(field => !newPwFields.includes(field) && (field.autocomplete.includes('current') ||
                        field.name.match(oldPassRegex) || field.id.match(oldPassRegex)));

                    if (passwordFields.includes(input)) {
                        placeIcon(input, oldPwFields.includes(input) ? 'password' : 'newPassword');
                    } else {
                        placeIcon(input, 'username');
                    }
                }
            }
            // TODO formless inputs
        });
    }

    function calculateIconPos(input: HTMLElement, inputWidth = 16, inputHeight = 16, marginRight = 8) {
        const inputPosition = input.getBoundingClientRect();
        const parentPosition = input.offsetParent && input.offsetParent.tagName !== 'BODY' ?
            input.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
        if (!inputPosition) return;

        return {left: inputPosition.left + inputPosition.width - inputWidth - marginRight - parentPosition.left,
                top: inputPosition.top + (inputPosition.height - inputHeight) / 2 - parentPosition.top};
    }

    function checkPositions() {
        activeIcons.forEach(icon => {
            const iconElement = icon.icon;
            if (document.body.contains(icon.input)) {
                const position = calculateIconPos(icon.input);
                if (position) {
                    if (position.left !== parseInt(iconElement.style.left, 10)) iconElement.style.left = position.left + 'px';
                    if (position.top !== parseInt(iconElement.style.top, 10)) iconElement.style.top = position.top + 'px';
                }
            } else {
                iconElement.remove();
                activeIcons = activeIcons.filter(iconData => iconData !== icon);
            }
        });

        activeOverlays.forEach(overlay => {
            const overlayElement = overlay.overlay;
            if (document.body.contains(overlay.icon.icon)) {
                const position = calcualteOverlayPos(overlay.icon.input);
                if (position) {
                    if (position.left !== parseInt(overlayElement.style.left, 10)) overlayElement.style.left = position.left + 'px';
                    if (position.top !== parseInt(overlayElement.style.top, 10)) overlayElement.style.top = position.top + 'px';
                    if (position.width !== parseInt(overlayElement.style.width, 10)) overlayElement.style.width = position.width + 'px';
                    if (position.height !== parseInt(overlayElement.style.height, 10)) overlayElement.style.height = position.height + 'px';
                }
            } else {
                closeAllOverlays();
            }
        });
    }

    function placeIcon(input: HTMLElement, type = 'username') {
        if (activeIcons.some(icon => icon.input === input)) return;
        const position = calculateIconPos(input);
        if (!position) return;

        const iconElement = document.createElement('span');
        iconElement.className = 'bitwarden';
        iconElement.style.setProperty('all', 'initial', '');

        let imagePath = 'shield';
        switch (type) {
            case 'newPassword':
                imagePath = 'refresh';
                break;
            case 'username':
                if (cipherData.usernameCiphers > 0)
                    imagePath = 'shield-blue';
                break;
            case 'password':
                if (cipherData.passwordCiphers > 0)
                    imagePath = 'shield-blue';
                break;
            default:
                if (cipherData.ciphers > 0)
                    imagePath = 'shield-blue';
                break;
        }

        const styleOverrides: { [key: string]: string } = {
            width: '16px',
            minWidth: '16px',
            height: '16px',
            minHeight: '16px',
            background: 'url(' + chrome.runtime.getURL(`images/${imagePath}.svg`) + ') center center / contain no-repeat',
            position: 'absolute',
            zIndex: window.getComputedStyle(input).zIndex || 'auto',
            left: position.left + 'px',
            top: position.top + 'px',
            border: 'none',
            display: 'inline',
        };
        Object.keys(styleOverrides).forEach(styleKey => {
            iconElement.style[styleKey as any] = styleOverrides[styleKey];
        });
        iconElement.addEventListener('click', e => {
            if (e.isTrusted) onIconClick({icon: iconElement, input: input}, type);
        });
        activeIcons.push({icon: iconElement, input: input});
        input.parentElement.appendChild(iconElement);
    }

    function calcualteOverlayPos(input: HTMLElement, marginLeft = 0, marginTop = 5) {
        const inputPosition = input.getBoundingClientRect();
        if (!inputPosition) return;

        return {left: window.pageXOffset + inputPosition.left + marginLeft,
                top: window.pageYOffset + inputPosition.top + inputPosition.height + marginTop,
                width: inputPosition.width,
                height: 350};
    }

    function onIconClick(icon: {icon: HTMLElement, input: HTMLElement}, type: string) {
        const isAlreadyOpen = activeOverlays.some(overlay => overlay.icon.icon === icon.icon);
        closeAllOverlays();
        if (isAlreadyOpen) return;

        const position = calcualteOverlayPos(icon.input);
        const overlayElement = document.createElement('iframe');
        overlayElement.className = 'bitwarden';
        overlayElement.style.setProperty('all', 'initial', '');
        const styleOverrides: { [key: string]: string } = {
            width: position.width + 'px',
            minWidth: '300px',
            height: position.height + 'px',
            minHeight: '350px',
            position: 'absolute',
            zIndex: '2147483647',
            left: position.left + 'px',
            top: position.top + 'px',
            border: 'none',
            display: 'inline',
        };
        Object.keys(styleOverrides).forEach(styleKey => {
            overlayElement.style[styleKey as any] = styleOverrides[styleKey];
        });
        activeOverlays.push({overlay: overlayElement, icon: icon});
        document.body.appendChild(overlayElement);
        overlayElement.contentWindow.location = chrome.extension.getURL('popup/index.html') + '?uilocation=overlay#/tabs/' +
            (type === 'newPassword' ? 'generator' : 'current') as any;
    }

    function closeAllOverlays() {
        while (activeOverlays.length) activeOverlays.pop().overlay.remove();
    }

    function isInIframe() {
        try {
            return window.self !== window.top;
        } catch {
            return true;
        }
    }

    function closeExistingAndOpenBar(type: string, typeData: any) {
        let barPage = 'notification/bar.html';
        switch (type) {
            case 'info':
                barPage = barPage + '?info=' + typeData.text;
                break;
            case 'warning':
                barPage = barPage + '?warning=' + typeData.text;
                break;
            case 'error':
                barPage = barPage + '?error=' + typeData.text;
                break;
            case 'success':
                barPage = barPage + '?success=' + typeData.text;
                break;
            case 'add':
                barPage = barPage + '?add=1';
                break;
            case 'change':
                barPage = barPage + '?change=1';
                break;
            default:
                break;
        }

        const frame = document.getElementById('bit-notification-bar-iframe') as HTMLIFrameElement;
        if (frame != null && frame.src.indexOf(barPage) >= 0) {
            return;
        }

        closeBar(false);
        openBar(type, barPage);
    }

    function openBar(type: string, barPage: string) {
        barType = type;

        if (document.body == null) {
            return;
        }

        const barPageUrl: string = chrome.extension.getURL(barPage);

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'height: 42px; width: 100%; border: 0; min-height: initial;';
        iframe.id = 'bit-notification-bar-iframe';

        const frameDiv = document.createElement('div');
        frameDiv.setAttribute('aria-live', 'polite');
        frameDiv.id = 'bit-notification-bar';
        frameDiv.style.cssText = 'height: 42px; width: 100%; top: 0; left: 0; padding: 0; position: fixed; ' +
            'z-index: 2147483647; visibility: visible;';
        frameDiv.appendChild(iframe);
        document.body.appendChild(frameDiv);

        (iframe.contentWindow.location as any) = barPageUrl;

        const spacer = document.createElement('div');
        spacer.id = 'bit-notification-bar-spacer';
        spacer.style.cssText = 'height: 42px;';
        document.body.insertBefore(spacer, document.body.firstChild);
    }

    function closeBar(explicitClose: boolean) {
        const barEl = document.getElementById('bit-notification-bar');
        if (barEl != null) {
            barEl.parentElement.removeChild(barEl);
        }

        const spacerEl = document.getElementById('bit-notification-bar-spacer');
        if (spacerEl) {
            spacerEl.parentElement.removeChild(spacerEl);
        }

        if (!explicitClose) {
            return;
        }

        switch (barType) {
            case 'add':
                sendPlatformMessage({
                    command: 'bgAddClose',
                });
                break;
            case 'change':
                sendPlatformMessage({
                    command: 'bgChangeClose',
                });
                break;
            default:
                break;
        }
    }

    function adjustBar(data: any) {
        if (data != null && data.height !== 42) {
            const newHeight = data.height + 'px';
            doHeightAdjustment('bit-notification-bar-iframe', newHeight);
            doHeightAdjustment('bit-notification-bar', newHeight);
            doHeightAdjustment('bit-notification-bar-spacer', newHeight);
        }
    }

    function doHeightAdjustment(elId: string, heightStyle: string) {
        const el = document.getElementById(elId);
        if (el != null) {
            el.style.height = heightStyle;
        }
    }

    function sendPlatformMessage(msg: any) {
        chrome.runtime.sendMessage(msg);
    }
});
