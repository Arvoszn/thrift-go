from playwright.sync_api import sync_playwright
from datetime import datetime, timedelta, timezone
from pathlib import Path
import json
ARTIFACTS=Path(__file__).resolve().parents[1]/'review-artifacts'
ARTIFACTS.mkdir(exist_ok=True)
errors=[]
now=datetime.now(timezone.utc)
account={'id':'shop-1','name':'Thriftship','igUsername':'thriftship1','igId':'ig-1','hasToken':True,'readiness':{'instagram':{'ready':True,'issues':[]},'facebook':{'ready':False,'issues':['Reconnect Facebook to track Page comments.']}}}
item={'id':'drop-1','name':'Nike hoodie · size L','shopId':'shop-1','platform':'instagram','destinationId':'ig-1','postId':'post-1','mode':'demo','status':'ACTIVE','startingBid':500,'minIncrement':50,'currentBid':550,'highestBidder':{'id':'buyer-1','username':'karl'},'bids':[{'username':'karl','bidderId':'buyer-1','amount':550,'timestamp':now.isoformat()}],'deadline':(now+timedelta(hours=6)).isoformat(),'fulfillment':{'status':'AWAITING_PAYMENT'}}
state={'accounts':[account],'readiness':{'issues':[]},'settings':{'shop-1':{'gcashName':'Thrift Shop','gcashNumber':'09171234567','shippingFee':80,'paymentWindowHours':12}},'items':[item],'log':[{'event':'BID_ACCEPTED','itemId':'drop-1','bid':{'username':'karl','amount':550},'t':now.isoformat()}],'outbox':[]}
requests=[]
def handle(route):
    path=route.request.url.split('4333')[-1]
    method=route.request.method
    if path.startswith('/api/public-config'):return route.fulfill(json={'ok':True,'publicShopAccess':False,'connectionNotice':'Shop connections are currently limited to invited test accounts. Access for other shops is awaiting Meta approval.'})
    if path.startswith('/api/workspace'):return route.fulfill(json=state)
    if method=='POST':
        body=route.request.post_data_json;requests.append((path,body))
        if path=='/bids/api/items':
            made=dict(body,id='new-1',status='ACTIVE',currentBid=body['startingBid'],highestBidder=None,bids=[]);state['items'].append(made);return route.fulfill(json={'ok':True,'item':made})
        if path=='/bids/api/pay':item.update(status='PAID_CONFIRMED',fulfillment={'status':'READY_TO_SHIP'});return route.fulfill(json={'ok':True,'item':item})
        if path=='/bids/api/fulfillment':item['fulfillment']=body;return route.fulfill(json={'ok':True,'item':item})
        return route.fulfill(json={'ok':True})
    if path.startswith('/api/media'):return route.fulfill(json={'media':[{'id':'post-2','caption':'Levi’s 501 · waist 30'}]})
    return route.fulfill(json={'ok':False,'error':'Missing fixture route'},status=404)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1024})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/connect.html',lambda r:r.fulfill(body=(Path(__file__).resolve().parents[1]/'public/connect.html').read_text(encoding='utf-8'),content_type='text/html'))
    page.route('**/api/**',handle);page.route('**/bids/api/**',handle)
    page.goto('http://127.0.0.1:4333/connect.html');page.wait_for_load_state('networkidle')
    page.get_by_role('heading',name='Drops',exact=True).wait_for()
    page.screenshot(path=str(ARTIFACTS/'drops-desktop.png'),full_page=True)
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.get_by_role('link',name='New drop',exact=True).click()
    page.get_by_role('button',name='Choose from recent posts').click()
    page.get_by_role('button',name='Levi’s 501 · waist 30').click()
    assert page.get_by_label('Post ID',exact=True).input_value()=='post-2'
    page.get_by_label('Starting bid (₱)').fill('300');page.get_by_label('Minimum raise (₱)').fill('25')
    page.locator('#drop-options > summary').click()
    page.get_by_label('Drop mode').select_option('demo')
    page.get_by_role('button',name='Create drop',exact=True).click()
    page.get_by_role('heading',name='Levi’s 501 · waist 30',exact=True).wait_for()
    create=requests[-1][1];assert create['mode']=='demo' and create['startingBid']==300 and create['minIncrement']==25
    page.goto('http://127.0.0.1:4333/connect.html#detail/drop-1');page.wait_for_load_state('networkidle')
    before=len(requests)
    page.get_by_role('button',name='Close bidding',exact=True).click()
    page.get_by_role('dialog',name='Confirm action').wait_for()
    page.get_by_role('button',name='Cancel',exact=True).click()
    assert len(requests)==before,'Cancelling must not mutate the drop'
    page.get_by_role('button',name='Close bidding',exact=True).click()
    page.get_by_role('button',name='Continue',exact=True).click()
    page.wait_for_timeout(100)
    assert requests[-1][0]=='/bids/api/close','Confirmation must submit the scoped action'
    page.goto('http://127.0.0.1:4333/connect.html#shop');page.wait_for_load_state('networkidle')
    page.get_by_role('button',name='Check connection',exact=True).click()
    page.get_by_label('GCash account name').fill('Thriftship')
    page.get_by_role('button',name='Save shop settings').click()
    page.wait_for_timeout(150)
    assert requests[-1][0]=='/api/settings'
    item.update(status='PAYMENT_REVIEW',paymentDeadline=(now+timedelta(hours=12)).isoformat(),totalDue=630,paymentClaim={'referenceNo':'1234567890','amount':630})
    page.goto('http://127.0.0.1:4333/connect.html#detail/drop-1');page.wait_for_load_state('networkidle')
    page.get_by_label('I checked the payment').check()
    page.get_by_role('button',name='Confirm payment',exact=True).click()
    page.get_by_role('heading',name='Prepare shipping').wait_for()
    payment=[r[1] for r in requests if r[0]=='/bids/api/pay'][-1];assert payment['buyerId']=='buyer-1' and payment['amount']==630 and payment['referenceNo']=='1234567890'
    page.get_by_label('Recipient name').fill('Karl Reyes');page.get_by_label('Phone number').fill('09181234567');page.get_by_label('Shipping address',exact=True).fill('Surigao City');page.get_by_label('Courier',exact=True).fill('J&T');page.get_by_label('Tracking number',exact=True).fill('JT123456789');page.get_by_label('Order status').select_option('SHIPPED');page.get_by_role('button',name='Save shipping',exact=True).click()
    page.get_by_role('heading',name='Shipping details',exact=True).wait_for()
    assert not page.get_by_label('Recipient name').is_visible()
    page.locator('#shipping-edit > summary').click()
    assert page.get_by_label('Recipient name').input_value()=='Karl Reyes'
    page.locator('#shipping-edit > summary').click()
    page.wait_for_timeout(3300)
    shipment=[r[1] for r in requests if r[0]=='/bids/api/fulfillment'][-1];assert shipment['status']=='SHIPPED' and shipment['address']=='Surigao City' and shipment['recipientName']=='Karl Reyes'
    page.set_viewport_size({'width':390,'height':844})
    for hash in ['drops','payments','shop','new','detail/drop-1']:
        page.goto('http://127.0.0.1:4333/connect.html#'+hash);page.wait_for_load_state('networkidle')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),hash+' mobile overflow'
        page.screenshot(path=str(ARTIFACTS/(hash.replace('/','-')+'-mobile.png')),full_page=True)
    state['inbox']=[{'shopId':'shop-1','senderId':'buyer-1','text':'<img src=x onerror=window.evil=1>','timestamp':now.isoformat(),'attachments':[{'type':'image','url':'https://example.com/receipt.png'},{'type':'image','url':'javascript:alert(1)'}]},{'shopId':'other-shop','senderId':'buyer-1','text':'DO NOT EXPOSE'},{'shopId':'shop-1','senderId':'other-buyer','text':'OTHER BUYER PRIVATE'}]
    item['name']='A'*180
    item['highestBidder']['username']='B'*120
    item['bids'][0]['username']='C'*120
    page.goto('http://127.0.0.1:4333/connect.html#detail/drop-1');page.wait_for_load_state('networkidle')
    page.reload();page.wait_for_load_state('networkidle')
    assert page.get_by_role('link',name='Open receipt or image').count()==1
    assert not page.locator('img[onerror]').count()
    assert not page.evaluate('window.evil || false')
    assert 'DO NOT EXPOSE' not in page.locator('body').inner_text()
    assert 'OTHER BUYER PRIVATE' not in page.locator('body').inner_text()
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),'long text mobile overflow'
    page.goto('http://127.0.0.1:4333/connect.html#drops');page.wait_for_load_state('networkidle')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),'long drop title mobile overflow'
    page.route('**/api/workspace',lambda r:r.fulfill(status=401,json={'error':'Sign in'}))
    page.goto('http://127.0.0.1:4333/connect.html');page.wait_for_load_state('networkidle')
    page.get_by_role('heading',name='Your thrift drops, from bid to shipped.').wait_for()
    assert page.get_by_role('link',name='Continue with Instagram').get_attribute('href')=='/auth/start?platform=instagram'
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(ARTIFACTS/'login-mobile.png'),full_page=True)
    assert 'awaiting Meta approval' in page.locator('body').inner_text()
    # Isolated popup fixture: the parent stays put and only the owned popup can finish login.
    page.context.route('**/auth/start?platform=instagram',lambda r:r.fulfill(body='<html><title>Instagram login fixture</title><button onclick="window.opener.postMessage({type: \'thrift:connection\', ok: false, error: \'login_cancelled\'}, window.location.origin); window.close()">Cancel fixture login</button></html>',content_type='text/html'))
    parent_url=page.url
    with page.expect_popup() as popup_info:
        page.get_by_role('link',name='Continue with Instagram').click()
    popup=popup_info.value
    popup.get_by_role('button',name='Cancel fixture login').wait_for()
    assert page.url==parent_url,'Login must keep the shop page open'
    assert popup.url.endswith('/auth/start?platform=instagram')
    popup.get_by_role('button',name='Cancel fixture login').click()
    page.get_by_role('status').filter(has_text='Connection not completed').wait_for()
    assert page.url==parent_url,'Cancelling login must preserve the shop page'
    # Complete another owned popup and verify the native-only channel returns to Shop.
    page.context.route('**/auth/start?platform=instagram',lambda r:r.fulfill(body='<html><title>Instagram login fixture</title><button onclick="window.opener.postMessage({type: \'thrift:connection\', ok: true}, window.location.origin); window.close()">Complete fixture login</button></html>',content_type='text/html'))
    with page.expect_popup() as popup_info:
        page.get_by_role('link',name='Continue with Instagram').click()
    popup=popup_info.value
    popup.get_by_role('button',name='Complete fixture login').wait_for()
    account.update(authType='instagram',platforms=['instagram'])
    page.route('**/api/workspace',lambda r:r.fulfill(json=state))
    popup.get_by_role('button',name='Complete fixture login').click()
    page.get_by_role('heading',name='Shop',exact=True).wait_for()
    badges=page.locator('.account-row .badge').all_text_contents()
    assert len(badges)==1 and 'Instagram' in badges[0] and 'Facebook' not in badges[0]
    assert not errors,errors
    print(json.dumps({'passed':['desktop and 390px layouts','create from shop post','scoped shop settings','connection verification button','manual payment exact winner and total','structured shipping','signed-out one-click login','scoped safe receipt links','long unbroken text layout','inline confirmation cancel/continue','public approval notice','separate login popup with safe cancellation','popup return to native-only Instagram shop'],'pageErrors':errors,'mutations':len(requests)}))
    browser.close()
