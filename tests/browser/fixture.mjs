// Offline, disposable data only. Also runnable for the manual extension test plan.
export const SECRETS = {
  password: "FixturePassword-Only-927",
  otp: "684209",
  card: "4111111111111111",
};
export function fixtureResponse(request) {
  const path = new URL(request.url).pathname;
  if (path === "/ping") return Response.json({ fixture: true });
  if (!["/", "/form", "/next", "/privacy", "/login"].includes(path))
    return new Response("Not found", { status: 404 });
  const crossSite = new URL("/form", request.url);
  crossSite.hostname = crossSite.hostname === "localhost" ? "127.0.0.1" : "localhost";
  const privateFields = path === "/privacy" || path === "/login";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Remote Tab offline fixture</title>
<style>body{font:16px sans-serif;margin:24px;background:white}input,select,button{font:inherit;padding:8px;margin:6px}#submit:hover{outline:4px solid purple}#safe{position:absolute;left:500px;top:320px;width:120px;height:50px;background:rgb(255,255,0)}.private{position:absolute;left:30px;width:220px;height:44px;padding:0;border:0;margin:0}.secret-label{position:absolute;left:280px}#password{top:300px;background:red}#otp{top:370px;background:green}#card{top:440px;background:blue}#drag,#drop{display:inline-block;padding:12px;background:#ddd;margin:8px}</style></head><body>
<h1>${privateFields ? "Private test fields" : "Ordinary form"}</h1>
<label>Name <input id="name" aria-label="Name" autocomplete="off"></label>
<button id="submit">Submit</button><p id="result" role="status"></p>
<label>Color <select id="color" aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select></label>
<a href="/next">Next page</a><a href="${crossSite}">Other host</a><a href="/privacy">Private fields</a><button id="ping">Fetch local data</button>
<div><span id="drag" draggable="true" role="button" aria-label="Drag source">Drag source</span><span id="drop" role="button" aria-label="Drop target">Drop target</span></div>
${privateFields ? `<input class="private" id="password" type="password" aria-label="Password" autocomplete="current-password" value="${SECRETS.password}"><span class="secret-label" style="top:310px">Password</span><input class="private" id="otp" aria-label="One-time code" autocomplete="one-time-code" value="${SECRETS.otp}"><span class="secret-label" style="top:380px">One-time code</span><input class="private" id="card" aria-label="Card number" autocomplete="cc-number" value="${SECRETS.card}"><span class="secret-label" style="top:450px">Test card number</span><div id="safe">Ordinary pixels</div>` : ""}
<script>
submit.onclick=()=>{result.textContent='Submitted: '+document.querySelector('#name').value;console.log('fixture submitted')};
ping.onclick=async()=>{const data=await fetch('/ping').then(r=>r.json());result.textContent=JSON.stringify(data)};
drag.ondragstart=e=>e.dataTransfer.setData('text/plain','fixture');drop.ondragover=e=>e.preventDefault();drop.ondrop=e=>{e.preventDefault();result.textContent='Dropped'};
</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
if (import.meta.main) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.PORT || 8081),
    fetch: fixtureResponse,
  });
  console.log(`Disposable browser fixture: ${server.url}form and ${server.url}privacy`);
}
