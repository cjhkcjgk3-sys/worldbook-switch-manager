/** Run only against a disposable local SillyTavern test instance. Creates test data. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const url=process.env.WSM_LIVE_URL;
if(!url || !['127.0.0.1','localhost'].includes(new URL(url).hostname) || process.env.WSM_ISOLATED_TEST!=='1') throw new Error('Set WSM_LIVE_URL and WSM_ISOLATED_TEST=1 for a disposable localhost instance.');
const {chromium}=await import(process.env.WSM_PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({executablePath:process.env.WSM_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:1000}});
const errors=[], requests=[];
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/horde/**',route=>route.fulfill({json:route.request().url().includes('/status')?{ok:false}:[]}));
let responseNumber=0;
await page.route('**/api/backends/chat-completions/generate',async route=>{
    const body=route.request().postDataJSON();
    const text=JSON.stringify(body.messages);
    requests.push({raiden:text.includes('WSM_LIVE_RAIDEN_118'),rules:text.includes('WSM_LIVE_RULES_118'),disabled:text.includes('WSM_LIVE_DISABLED_118')});
    await route.fulfill({json:{id:'wsm-test',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:`Synthetic complete reply ${++responseNumber}.`},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}});
});
try {
    await page.goto(url);
    await page.waitForSelector('.popup-input',{state:'visible',timeout:3000}).then(async()=>{await page.locator('.popup-input:visible').fill('WSM Tester');await page.locator('.popup-button-ok:visible').click();}).catch(()=>{});
    await page.waitForSelector('#worldbook-switch-manager',{state:'attached'});
    const baseline=await page.evaluate(async()=>{
        const ctx=SillyTavern.getContext();
        const wi=await import('/scripts/world-info.js');
        const name=`WSM Live Test ${Date.now()}`;
        const data={entries:{}};
        for(const fields of [
            {comment:'雷电将军',key:['雷电将军'],content:'WSM_LIVE_RAIDEN_118 '+('人物资料用于运行测试。'.repeat(1000))},
            {comment:'世界规则',constant:true,content:'WSM_LIVE_RULES_118'},
            {comment:'原本禁用',constant:true,disable:true,content:'WSM_LIVE_DISABLED_118'},
        ]) Object.assign(wi.createWorldInfoEntry(name,data),fields);
        await wi.saveWorldInfo(name,data,true);
        const card={spec:'chara_card_v2',spec_version:'2.0',data:{name,description:'A synthetic test character.',personality:'',scenario:'',first_mes:'Ready for the isolated test.',mes_example:'',creator_notes:'',system_prompt:'',post_history_instructions:'',alternate_greetings:[],tags:[],creator:'WSM test',character_version:'1',extensions:{world:name}}};
        const form=new FormData();form.append('avatar',new File([JSON.stringify(card)],'wsm-test.json',{type:'application/json'}));form.append('file_type','json');
        const response=await fetch('/api/characters/import',{method:'POST',headers:ctx.getRequestHeaders({omitContentType:true}),body:form});
        const imported=await response.json();if(!imported.file_name)throw new Error('Test character import failed: '+JSON.stringify(imported));
        await ctx.getCharacters();
        const index=SillyTavern.getContext().characters.findIndex(c=>c.avatar===imported.file_name || c.avatar===`${imported.file_name}.png`);
        if(index<0)throw new Error('Imported test character was not found');
        await SillyTavern.getContext().selectCharacterById(index);
        const core=await import('/script.js');const oai=await import('/scripts/openai.js');
        core.changeMainAPI('openai');
        Object.assign(oai.oai_settings,{chat_completion_source:'custom',custom_url:'http://127.0.0.1:9/v1',custom_model:'wsm-test',stream_openai:false,openai_max_context:32768,openai_max_tokens:64,squash_system_messages:false});
        wi.setWorldInfoSettings({world_info_budget:80},{});
        core.setOnlineStatus('wsm-local-synthetic-backend');
        const settings=SillyTavern.getContext().extensionSettings.worldbook_switch_manager;
        Object.assign(settings,{enabled:true,automatic:true,delay:0,cooldown:1,selection:{[name]:['0']}});
        ctx.saveSettingsDebounced();
        await ctx.eventSource.emit(ctx.eventTypes.WORLDINFO_SETTINGS_UPDATED);
        return {world:name,serialized:JSON.stringify(await ctx.loadWorldInfo(name)),avatar:imported.file_name};
    });
    console.log('Native test character ready:',baseline.avatar);
    console.log('Native selection:',await page.evaluate(()=>{const c=SillyTavern.getContext();return {id:c.characterId,character:c.characters[c.characterId]?.name,world:c.characters[c.characterId]?.data?.extensions?.world,chat:c.getCurrentChatId()}}));
    async function turn(type='normal') {
        await page.evaluate(async type=>{
            const core=await import('/script.js');core.setOnlineStatus('wsm-local-synthetic-backend');
            if(type==='normal') document.querySelector('#send_textarea').value='雷电将军现在在哪里？';
            await SillyTavern.getContext().generate(type);
        },type);
        return requests.at(-1);
    }
    assert.deepEqual(await turn(),{raiden:true,rules:true,disabled:false});
    assert.deepEqual(await turn(),{raiden:false,rules:true,disabled:false});
    assert.deepEqual(await turn('regenerate'),{raiden:false,rules:true,disabled:false});
    assert.deepEqual(await turn(),{raiden:true,rules:true,disabled:false});
    assert.match(await page.locator('.wsm-scope').innerText(),/已完成 3 回合/);
    assert.equal(await page.evaluate(()=>Object.hasOwn(SillyTavern.getContext().chatMetadata,'worldbook_switch_manager')),false);
    assert.equal(await page.evaluate(async name=>{const ctx=SillyTavern.getContext();const response=await fetch('/api/worldinfo/get',{method:'POST',headers:ctx.getRequestHeaders(),body:JSON.stringify({name})});return JSON.stringify(await response.json());},baseline.world),baseline.serialized);
    console.log('Native three-turn request trace + regeneration: PASS');
    await page.locator('#extensionsMenuButton').click();
    await page.locator('#worldbook_switch_manager_wand_button').click();
    await page.getByText(`${baseline.world} · 3 条`,{exact:true}).click();
    await page.getByRole('combobox',{name:'选择用途'}).selectOption('manual');
    await page.getByRole('checkbox',{name:'雷电将军',exact:true}).check();
    await page.getByLabel('手动冻结回合',{exact:true}).fill('3');
    await page.getByRole('button',{name:'冻结所选',exact:true}).click();
    assert.match(await page.locator('.wsm-entry').first().innerText(),/手动冻结剩余 3 回合/);
    assert.match(await page.locator('.wsm-entry').first().innerText(),/自动冷却/);
    assert.deepEqual(await turn(),{raiden:false,rules:true,disabled:false});
    assert.deepEqual(await turn(),{raiden:false,rules:true,disabled:false});
    await page.getByRole('button',{name:'解除所选手动冻结',exact:true}).click();
    assert.deepEqual(await turn(),{raiden:true,rules:true,disabled:false});
    await page.screenshot({path:fileURLToPath(new URL('../docs/live-1.18-preview.png',import.meta.url)),fullPage:true});
    await page.locator('.popup-button-ok').click();
    await page.waitForFunction(()=>!document.querySelector('.popup'));
    // Use the native message editor; no synthetic edit event is emitted by this test.
    const last=page.locator('#chat .mes').last();
    await last.locator('.mes_edit').click({force:true});
    await last.locator('textarea.edit_textarea').fill('Edited synthetic reply.');
    await last.locator('.mes_edit_done').click({force:true});
    await page.waitForFunction(()=>document.querySelector('.wsm-scope').textContent.includes('已完成 0 回合'));
    assert.deepEqual(await turn(),{raiden:true,rules:true,disabled:false});
    const originalChat=await page.evaluate(()=>SillyTavern.getContext().getCurrentChatId());
    await page.evaluate(()=>SillyTavern.getContext().openCharacterChat(`WSM Reset Test ${Date.now()}`));
    assert.match(await page.locator('.wsm-scope').textContent(),/已完成 0 回合/);
    await page.evaluate(chat=>SillyTavern.getContext().openCharacterChat(chat),originalChat);
    assert.match(await page.locator('.wsm-scope').textContent(),/已完成 0 回合/);
    assert.deepEqual(await turn(),{raiden:true,rules:true,disabled:false});
    await page.evaluate(()=>SillyTavern.getContext().saveSettingsDebounced.flush?.());
    // Native settings debounce is 1 second; wait on the actual persisted response.
    await page.waitForTimeout(1500);
    await page.reload();await page.waitForSelector('#worldbook-switch-manager',{state:'attached'});
    assert.match(await page.locator('.wsm-scope').innerText(),/已完成 0 回合/);
    assert.equal(await page.evaluate(()=>SillyTavern.getContext().extensionSettings.worldbook_switch_manager.cooldown),1);
    assert.equal(await page.evaluate(()=>Object.hasOwn(SillyTavern.getContext().chatMetadata,'worldbook_switch_manager')),false);
    assert.deepEqual(errors,[]);
    const result={environment:'Official SillyTavern 1.18.0 / 51ad27fb86d39a3daca3adaa970375c9670c12df; isolated local instance; real native generation pipeline; synthetic model responses intercepted at HTTP request',version:'1.2.0',result:'PASS',requests,checks:['extension loaded through native activate hook','magic wand menu entry opens the manager popup','native budget/keyword processing','three-turn open/closed/open','regeneration stays closed, no double count','unselected constant rule preserved','original disabled entry stays disabled','worldbook JSON unchanged','no plugin chat metadata','manual and auto rules coexist; manual release restores eligibility','native message editor resets runtime state','native chat switch away and back resets progress','reload resets runtime state; global rule retained','no browser exceptions']};
    await writeFile(new URL('../docs/live-1.18-results.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
