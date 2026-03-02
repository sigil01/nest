// Uses the global `nest` object from /nest-sdk.js (loaded via <script> tag)

var div = document.createElement('div');
div.style.padding = '1rem';
div.style.textAlign = 'center';
div.style.fontFamily = 'system-ui, sans-serif';
div.innerHTML = '<h3>👋 Hello from an extension!</h3><p>Running in a sandboxed iframe.</p>';
document.body.appendChild(div);

// Auto-size the iframe to fit content
nest.resize(document.body.scrollHeight);
