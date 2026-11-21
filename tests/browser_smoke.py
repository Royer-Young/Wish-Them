"""Local browser acceptance checks. Requires Python Playwright and system Edge."""
from pathlib import Path
import json
import sys
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda err: errors.append(str(err)))
    page.goto('http://127.0.0.1:5173/')
    expect(page.get_by_role('button', name='替TA许个愿', exact=True)).to_be_visible()
    print(page.locator('nav').aria_snapshot())
    page.screenshot(path=str(OUT / '01-home.png'), full_page=True)
    page.get_by_role('button', name='替TA许个愿', exact=True).click()
    page.get_by_label('你平时怎么称呼TA？').fill('妈妈')
    page.get_by_role('button', name='下一步', exact=True).click()
    page.get_by_label('写下你的愿望').fill('希望妈妈每天都能睡个好觉。')
    page.get_by_role('button', name='下一步', exact=True).click()
    for _ in range(5):
        page.get_by_role('button', name='跳过这题', exact=True).click()
    page.get_by_label('签下你的称呼').fill('小叶')
    page.get_by_role('checkbox').check()
    page.get_by_role('button', name='签下约定', exact=True).click()
    expect(page.get_by_role('heading', name='今天，也替心意走一小步')).to_be_visible()
    page.get_by_role('button', name='去记录', exact=True).first.click()
    expect(page.get_by_role('button', name='收好今天的记录')).to_be_disabled()
    page.locator('input[type=file]').set_input_files(str(ROOT / 'public/assets/postoffice.png'))
    page.get_by_label('留一句话（可选）').fill('今天给妈妈打了电话。')
    expect(page.get_by_role('button', name='收好今天的记录')).to_be_enabled()
    page.get_by_role('button', name='收好今天的记录').click()
    expect(page.get_by_text('已完成 1/2', exact=True)).to_be_visible()
    page.reload()
    expect(page.get_by_text('已完成 1/2', exact=True)).to_be_visible()
    page.screenshot(path=str(OUT / '02-today.png'), full_page=True)
    page.get_by_role('link', name='账本', exact=True).click()
    page.get_by_label('记账类型').select_option('budget')
    page.get_by_label('金额（元，取整）').fill('80')
    page.get_by_role('button', name='记到账本', exact=True).click()
    expect(page.locator('.ledger-row')).to_have_count(1)
    page.get_by_label('记账类型').select_option('expense')
    page.get_by_label('金额（元，取整）').fill('32')
    page.get_by_role('button', name='记到账本', exact=True).click()
    expect(page.locator('.ledger-summary .total strong')).to_have_text('¥48')
    page.screenshot(path=str(OUT / '03-ledger.png'), full_page=True)
    page.get_by_role('link', name='愿签池', exact=True).click()
    page.get_by_role('button', name='睡眠', exact=True).click()
    expect(page.locator('.pool-grid>.paper')).to_have_count(1)
    page.get_by_role('button', name='读一读这份心意').click()
    page.get_by_label('留一句温柔的话').fill('愿你和妈妈都睡得好。')
    page.get_by_role('button', name='收好这句话').click()
    expect(page.locator('.reply')).to_have_count(1)
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog')).to_have_count(0)
    page.screenshot(path=str(OUT / '04-pool.png'), full_page=True)
    page.goto('http://127.0.0.1:5173/#/demo')
    expect(page.get_by_text('独立演示 · 不影响你的愿签')).to_be_visible()
    page.get_by_role('button', name='查看两幕结算').click()
    expect(page.locator('.stamp')).to_have_text('已还愿')
    page.get_by_role('button', name='继续，打开问号抽屉').click()
    expect(page.locator('.settle-sum strong')).to_have_text('¥168')
    page.screenshot(path=str(OUT / '05-settlement.png'), full_page=True)
    page.get_by_label('演示结局').select_option('unfinished')
    expect(page.locator('.stamp')).to_have_text('待续的心意')
    page.get_by_label('演示结局').select_option('cyber')
    expect(page.locator('.stamp')).to_have_text('已还愿')
    page.get_by_role('button', name='继续，打开问号抽屉').click()
    expect(page.locator('.settle-sum strong')).to_have_text('¥0')
    page.get_by_role('button', name='退出演示').click()
    page.get_by_role('link', name='账本', exact=True).click()
    expect(page.locator('.ledger-summary .total strong')).to_have_text('¥48')
    for width in [1920, 1440, 1280, 768, 375]:
        page.set_viewport_size({'width': width, 'height': 900})
        for route in ['/', '/start', '/today', '/ledger', '/pool', '/me']:
            page.goto('http://127.0.0.1:5173/#' + route)
            page.wait_for_timeout(120)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'overflow {width} {route}'
        if width == 375:
            page.screenshot(path=str(OUT / '06-mobile.png'), full_page=True)
    assert not errors, errors
    print(json.dumps({'result': 'passed', 'browserErrors': errors, 'screenshots': str(OUT), 'checks': ['create', 'image-required', 'checkin', 'refresh', 'ledger', 'pool-reply', 'dialog-escape', 'three-outcomes', 'demo-isolation', 'responsive-five-widths']}, ensure_ascii=False))
    browser.close()
