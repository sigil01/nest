// public/nest-sdk.js — served at /nest-sdk.js
// Extensions use this as a classic script: <script src="/nest-sdk.js"></script>
// The `nest` object is available as a global (window.nest).

(function () {
    'use strict';

    var pending = new Map();
    var eventListeners = new Map();
    var REQUEST_TIMEOUT_MS = 30000;

    function genId() {
        return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    }

    function request(action, args) {
        return new Promise(function (resolve, reject) {
            var id = genId();
            var timer = setTimeout(function () {
                pending.delete(id);
                reject(new Error('Request timeout: ' + action));
            }, REQUEST_TIMEOUT_MS);
            pending.set(id, {
                resolve: function (v) { clearTimeout(timer); resolve(v); },
                reject: function (e) { clearTimeout(timer); reject(e); },
            });
            window.parent.postMessage({ type: 'nest', id: id, action: action, args: args }, '*');
        });
    }

    window.addEventListener('message', function (e) {
        var msg = e.data;
        if (msg && msg.type === 'nest-reply' && msg.id) {
            var p = pending.get(msg.id);
            if (p) {
                pending.delete(msg.id);
                if ('error' in msg) p.reject(new Error(msg.error));
                else p.resolve(msg.result);
            }
        } else if (msg && msg.type === 'nest-event') {
            var listeners = eventListeners.get(msg.name) || [];
            for (var i = 0; i < listeners.length; i++) listeners[i](msg.detail);
        } else if (msg && msg.type === 'nest-theme') {
            var root = document.documentElement;
            var vars = msg.vars;
            for (var prop in vars) {
                if (vars.hasOwnProperty(prop)) {
                    root.style.setProperty(prop, vars[prop]);
                }
            }
        }
    });

    window.nest = {
        fetch: function (url, init) {
            return request('fetch', { url: url, init: init });
        },
        readFile: function (root, path) {
            return request('readFile', { root: root, path: path });
        },
        writeFile: function (root, path, content) {
            return request('writeFile', { root: root, path: path, content: content });
        },
        state: {
            get: function (key) {
                return request('state.get', { key: key });
            },
            set: function (key, value) {
                return request('state.set', { key: key, value: value });
            },
        },
        on: function (name, fn) {
            if (!eventListeners.has(name)) eventListeners.set(name, []);
            eventListeners.get(name).push(fn);
            return function () {
                var arr = eventListeners.get(name);
                if (arr) {
                    var idx = arr.indexOf(fn);
                    if (idx >= 0) arr.splice(idx, 1);
                }
            };
        },
        resize: function (height) {
            window.parent.postMessage({ type: 'nest-resize', height: height }, '*');
        },
    };
})();
