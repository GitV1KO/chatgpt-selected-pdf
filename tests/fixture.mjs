/** Local synthetic ChatGPT documents. No account, API, CDN, or external assets. */
export function fixtureHTML() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>可选择 PDF 测试会话 · ChatGPT</title><link rel="icon" href="data:,">
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Arial",sans-serif;background:#fff;color:#171717}
html.dark,html.dark body{background:#212121;color:#ececec}body{--paper:#fff;--bubble:#f4f4f4;--code:#f7f7f8;--line:#ddd}body.dark{--paper:#212121;--bubble:#303030;--code:#171717;--line:#555}
header{height:56px;padding:12px 24px;border-bottom:1px solid var(--line);position:relative;z-index:6;background:var(--paper)}
main{height:calc(100vh - 56px);overflow:auto;overflow-anchor:none;padding:24px 24px 148px;scroll-behavior:auto;scrollbar-gutter:stable}
#turns{max-width:768px;margin:0 auto}article{margin:0 0 32px;position:relative;overflow-wrap:anywhere}
article[data-fixture-role=user]{padding:14px 22px;background:var(--bubble);border-radius:24px;margin-left:96px;width:calc(100% - 96px)}
article[data-fixture-role=assistant]{padding:8px 0}p{margin:0 0 16px}p:last-child{margin-bottom:0}h2{font-size:23px;line-height:1.4;margin:28px 0 14px}h3{font-size:19px;margin:22px 0 10px}
a{color:#1478c8;text-decoration:underline}blockquote{margin:14px 0;border-left:4px solid #aaa;padding:4px 18px;background:#8881}
pre{margin:14px 0;border:1px solid var(--line);border-radius:12px;background:var(--code);overflow:auto;white-space:pre;font:14px/1.7 ui-monospace,Menlo,monospace}
.code-title{background:#8881;border-bottom:1px solid var(--line);font:12px/1.5 system-ui;padding:8px 14px}code.code-body{display:block;padding:14px;color:inherit;min-width:max-content}.kw{color:#b55de0}.fn{color:#cc7212}.str{color:#09835b}.comment{color:#777}
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:15px}td,th{border:1px solid var(--line);padding:10px 16px;text-align:left}th{background:#8881}tr:nth-child(2n){background:#8880800a}
.math{display:flex;justify-content:center;margin:22px 0;color:inherit}.math svg{max-width:100%;height:auto}.rich-grid{display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin:18px 0}.rich-grid img,.rich-grid canvas{border-radius:10px;max-width:100%;object-fit:contain}.accent{border-left:5px solid #13a57c;padding:12px 16px;background:#13a57c10}
.swatch{height:36px;display:flex;margin:18px 0}.swatch span{flex:1}.folded{display:none}.message-actions{font-size:12px;color:#777;padding-top:10px}
form{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);width:min(720px,calc(100vw - 32px));padding:12px 18px;border:1px solid var(--line);background:var(--bubble);border-radius:24px;z-index:7;display:flex;gap:10px;height:72px}textarea{flex:1;min-width:0;color:inherit;background:transparent;border:0;resize:none;font:inherit}form button{width:40px;height:40px;border:0;border-radius:50%;background:#222;color:white}
@media(max-width:700px){main{padding:20px 20px 140px}article[data-fixture-role=user]{margin-left:30px;width:calc(100% - 30px)}.rich-grid{gap:8px}}
</style></head><body><header>ChatGPT · 可选择 PDF 本地测试会话</header><main><div id="turns"></div></main>
<form aria-label="聊天输入框"><textarea id="prompt-textarea" placeholder="输入消息" aria-label="消息输入框"></textarea><button type="submit" aria-label="发送消息">↑</button></form>
<script>
(() => {
  const turns=document.querySelector('#turns'),main=document.querySelector('main');
  const params=new URL(location.href).searchParams;
  let layout=params.get('layout')||'legacy', prefix='fixture', serial=0;
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" fill="#e9f7f3"/><path d="M20 130L70 95L120 105L170 55L220 70L290 20" fill="none" stroke="#0b9b75" stroke-width="6"/><circle cx="170" cy="55" r="8" fill="#f0a126"/><text x="20" y="25" fill="#173e34" font-family="Arial" font-size="16">Local image · 320 × 160</text></svg>';
  const image='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  const formula='<div class="math" aria-label="求和公式"><svg xmlns="http://www.w3.org/2000/svg" width="420" height="90" viewBox="0 0 420 90" role="img" aria-label="E 等于 sigma p log p"><g fill="currentColor" font-family="Georgia,serif"><text x="16" y="57" font-size="30">E = −</text><text x="120" y="62" font-size="56">Σ</text><text x="135" y="18" font-size="15">n</text><text x="129" y="84" font-size="15">i=1</text><text x="176" y="57" font-size="29">p</text><text x="194" y="66" font-size="17">i</text><text x="211" y="57" font-size="29">log₂ p</text><text x="303" y="66" font-size="17">i</text></g></svg></div>';
  const code='<pre><div class="code-title">JavaScript · 已高亮代码</div><code class="code-body"><span class="kw">async function</span> <span class="fn">exportSelected</span>(messages) {\\n  <span class="comment">// 中文注释、符号和缩进必须保持</span>\\n  <span class="kw">const</span> title = <span class="str">"所见即所得：PDF 导出"</span>;\\n  <span class="kw">return await</span> savePDF(messages, { title, quality: <span class="str">"visible pixels"</span> });\\n}</code></pre>';
  const table='<table><thead><tr><th>内容</th><th>屏幕效果</th><th>验证点</th></tr></thead><tbody><tr><td>中文与 English</td><td>粗体、斜体、链接</td><td>字体与行距</td></tr><tr><td>公式与代码</td><td>排版后图形</td><td>颜色与缩进</td></tr><tr><td>表格、图片、画布</td><td>实际页面像素</td><td>宽度与边界</td></tr></tbody></table>';
  function node(role,id,html) {
    const article=document.createElement('article');article.dataset.testid='conversation-turn-'+serial++;article.dataset.fixtureRole=role;article.dataset.turnId=id;
    const message=document.createElement('div');message.className=role==='assistant'?'markdown prose':'whitespace-pre-wrap';message.dataset.fixtureMessage=id;
    if(layout==='legacy'){message.dataset.messageAuthorRole=role;message.dataset.messageId=id}else{article.dataset.turnKey='fixture-turn-'+Math.floor((serial-1)/2);message.dataset.chatgptSearchUnitKey='fixture:'+id+':0:'+role;message.dataset.contentSearchUnitKey='fixture:'+id+':0:'+role;message.dataset.chatgptSearchMessageIds=JSON.stringify([id]);}
    message.innerHTML=html;article.append(message);
    const actions=document.createElement('div');actions.className='message-actions';actions.textContent=role==='user'?'编辑问题':'复制　赞　重试';article.append(actions);
    return article;
  }
  function answer(n,long=false){
    if(n===1)return '<h2>渲染后的内容保真检查</h2><p>这是回答一。包含<strong>粗体文字</strong>、<em>斜体文字</em>、<a href="https://example.invalid/document">普通链接</a>与中文标点：，。！？</p><blockquote>选择问题与回答后，应保留你在网页上看到的排版、颜色和图形。</blockquote>'+formula+code+table+'<div class="rich-grid"><img src="'+image+'" width="320" height="160" alt="本地折线示意图"><canvas width="320" height="160" aria-label="Canvas 渲染图"></canvas></div><p class="accent">回答一结束：绿色提示框与图像边界必须完整。</p>';
    if(n===2||long)return '<h2>长回答：分页连续性</h2>'+Array.from({length:20},(_,i)=>'<section data-fixture-paragraph="'+i+'"><h3>第 '+(i+1)+' 节 · '+(i%2?'连续内容':'中文换行')+'</h3><p>段落 '+(i+1)+'：这是一段用于验证跨视口截图和 PDF 分页的长回答。'+ '中英文混排、数字 0123456789 与标点都应跟随浏览器原有布局。'.repeat(3)+'</p>'+(i%4===0?'<div class="swatch"><span style="background:#f04f63"></span><span style="background:#19a98c"></span><span style="background:#247ad1"></span><span style="background:#e6b02b"></span></div>':'')+'</section>').join('')+'<p class="accent">长回答尾部标记：END-LONG-ANSWER</p>';
    return '<h2>回答 '+n+'</h2><p>第 '+n+' 轮回答：'+ '只导出被明确选择的内容，未选择消息应被跳过。'.repeat(4)+'</p>';
  }
  function paint(){for(const canvas of turns.querySelectorAll('canvas')){const ctx=canvas.getContext('2d');ctx.fillStyle='#172a47';ctx.fillRect(0,0,320,160);ctx.fillStyle='#f0b343';ctx.fillRect(25,95,45,40);ctx.fillStyle='#42c5a6';ctx.fillRect(95,65,45,70);ctx.fillStyle='#7aaaff';ctx.fillRect(165,30,45,105);ctx.fillStyle='#fff';ctx.font='16px sans-serif';ctx.fillText('Canvas · 实际绘制像素',25,23)}}
  function reset(count=4,newPrefix='fixture',newLayout=layout){layout=newLayout;prefix=newPrefix;serial=0;turns.replaceChildren();for(let n=1;n<=count;n++){turns.append(node('user',prefix+'-u-'+n,'<p>问题 '+n+'：'+(n===1?'请说明中文、公式、代码、表格和图片如何显示。':n===2?'请给一段足够长的回答，验证多页 PDF。':'这是可单独选择的第 '+n+' 个问题。')+'</p>'));turns.append(node('assistant',prefix+'-a-'+n,answer(n)))}paint();main.scrollTop=0;}
  window.fixture={reset,inactiveShell(){const shell=document.createElement('div');shell.dataset.appShellActivePage='false';shell.innerHTML='<main><article><div data-message-author-role="user" data-message-id="stale-shell"><p>旧会话不得识别或导出</p></div></article></main>';document.body.prepend(shell)},route(path,count=2,newLayout=layout,delay=0){history.pushState({},'',path);setTimeout(()=>reset(count,'route-'+Date.now(),newLayout),delay)},dark(value){document.documentElement.classList.toggle('dark',value);document.body.classList.toggle('dark',value);document.documentElement.style.colorScheme=value?'dark':'light'},hideClone(id){const old=turns.querySelector('[data-fixture-message="'+id+'"]').closest('article');const clone=old.cloneNode(true);old.style.display='none';old.after(clone);paint()},append(){const n=++serial;turns.append(node('user','appended-u-'+n,'<p>动态追加的问题 '+n+'</p>'));turns.append(node('assistant','appended-a-'+n,'<p>动态追加的回答 '+n+'</p>'));},unselectedSentinel(){return 'UNSELECTED-MESSAGE-MUST-NOT-EXPORT'},raw(){return [...turns.querySelectorAll('article')].filter(e=>e.getClientRects().length).map(e=>({id:e.dataset.turnId,role:e.dataset.fixtureRole,text:e.querySelector('[data-fixture-message]').textContent}))}};
  document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.fixture.append()});
  reset(Number(params.get('count')||4));if(params.get('dark')==='1')window.fixture.dark(true);
})();
</script></body></html>`;
}
