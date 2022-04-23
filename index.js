const puppeteer = require("puppeteer");
const fs = require('fs');
var express = require("express");
var app = express();
app.set('views', __dirname + '/views');
app.engine('html', require('ejs').renderFile);

const maxLevel = 3;
const visitedUrls = [];
let documents = [];
let browser;
let jsonData;

// process.on('unhandledRejection', (reason, p) => {
// 	console.error('Unhandled Rejection at: Promise', p, 'reason:', reason);
// });

async function startBrowser() {
	let browser;
	try {
		console.log("Opening the browser......");
		browser = await puppeteer.launch({
			headless: true,
			args: [
				'--disable-setuid-sandbox'
				,'--no-sandbox'
			],
			'ignoreHTTPSErrors': true
		});
	} catch (err) {
		console.log("Could not create a browser instance => : ", err);
	}
	return browser;
}

async function getInnerText(page, selector) {
	return await page.$eval(selector, (el) => el.innerText);
}

function isValidURL(string) {
	const res = string.match(/(http(s)?:\/\/.)?(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/g);
	return (res !== null)
};

function sleep(milliseconds) {
	const date = Date.now();
	let currentDate = null;
	do {
		currentDate = Date.now();
	} while (currentDate - date < milliseconds);
}

const findBySelector = (page, selector, attribute)=>page.evaluate(()=> {
	console.log("selector", selector)
	const element = document.querySelector(selector)
	if (element) {
		return element.getAttribute(attribute)
	}
	return '';
})

async function fetchDocumentInfosPuppeteer(url) {
	if (!browser) browser = await startBrowser();
	const page = await browser.newPage();
	await page.setViewport({
		width: 900,
		height: 500,
		deviceScaleFactor: 0.25,
	});
	await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36');
	await page.setJavaScriptEnabled(true);

	//Mark visited
	visitedUrls.push(url);
	if (!isValidURL(url)) return;

	// Navigate to the page
	console.log(`Navigating to ${url}...`);
	await page.goto(url, {waitUntil: 'networkidle0'});
	sleep(1000)
	// Wait for the required DOM to be rendered
	await page.waitForSelector('body');
	await page.waitForSelector('a');
	const body = await getInnerText(page, '*');
	const title = await page.title();
	const metaContent = await page.evaluate(()=> {
		const element = document.querySelector('meta[name="description"')
		if (element) {
			return element.getAttribute('content')
		}
		return '';
	})
		// findBySelector(page,'meta[name="description"',  'content')
		// page.$eval('meta[name="description"', elem => elem?elem.getAttribute('content'):'')
	const header = await getInnerText(page, 'h1');
	// Get all the links
	const links = await page.$$eval('a', elements => {
		return elements.map(elem => elem.href);
	})

	const thumbnail = await page.screenshot({encoding: "base64", type: "jpeg", quality:90})

	const document = {
		'url': url,
		'title': title,
		'body_content': body,
		'meta_description': metaContent,
		'header': header,
		'links': [...new Set(links.filter(isValidURL))],
		'thumbnail':thumbnail,
		'type': 'page'
	};
	const imgElems = await page.evaluate(() => Array.from(document.images, e => ({
		src: e.src,
		alt: e.alt
	})));
	if(imgElems)
		await imgElems.forEach(e => crawlImg(e, url))

	await page.close();
	return document;
}

async function crawlImg(elem, parentUrl){
	if(!elem.src) return;
	if(documents.map(d=>d.url).includes(elem.src)) return;
	documents.push({
		'url': elem.src,
		'title': elem.alt,
		'body_content': elem.alt,
		'meta_description': elem.alt,
		'header': elem.alt,
		'links': [parentUrl],
		'type': 'image'
	});
}

async function crawl(url, level) {
	if (level >= maxLevel || visitedUrls.includes(url)) return;
	try {
		const doc = await fetchDocumentInfosPuppeteer(url);
		if(doc){
			documents.push(doc);
			await Promise.all(doc.links.map(link => crawl(link, level + 1)))
		}
	} catch (e) {
		console.log(e)
	}
	return;
}

startCrawl = async () => {
	try {
		await crawl('https://fordpro.com/en-us/', 0);
		console.log('Docs: ',documents)
		fs.writeFileSync('p_crawler_test.json', JSON.stringify({
			documents
		}, null, 4));
		console.log(`Successfully crawled ${documents.length} pages`)
		// process.exit(0);
	} catch (e) {
		console.log('Error', e);
		// process.exit(1);
	}
	if (browser) browser.close();
	return 'complete';
}

const queryMatch = (doc, text) => Object.keys(doc)
	.filter(k=>['header', 'meta_description', 'body_content', 'title'].includes(k))
	.filter(k => (doc[k]||'').toLowerCase().includes(text))
	.length>0;

app.listen(3001, async () => {
	console.log("web crawler server up");
});
app.get("/", (req, res) => {
	res.render('index.html');
})
app.get("/search", (req, res)=>{
	const rawData = fs.readFileSync('p_crawler_test.json');
	jsonData = //JSON.parse(rawData);
	{
		documents: JSON.parse(rawData).documents.filter((value, index, self) => {
			return self.findIndex(v => v.url === value.url) === index;
		})
	};
	let docs;
	switch(req.query.type){
		case 'img':
			docs = jsonData.documents.filter(d=>d.type=='image');
			break;
		case 'page':
			docs = jsonData.documents.filter(d=>d.type=='page');
			break;
		default:
			docs = jsonData.documents;
	}
	res.json(docs.filter((d)=>queryMatch(d,req.query.text.toLowerCase())))
})
app.get("/crawl", async (req, res) => {
	console.log('Started crawling')
	await startCrawl();
	const msg = 'Crawled '+documents.length+' documents';
	console.log(msg)
	res.json({
		'message': msg
	});
});

