const puppeteer = require("puppeteer");
const fs = require('fs');
const express = require("express");
const pdf2Html = require('pdf2html')
const app = express();
app.set('views', __dirname + '/views');
app.engine('html', require('ejs').renderFile);
app.use(express.static('public'));

const maxLevel = 3;
const crawlQueue = [];
const pdfQueue = [];
const visitedUrls = [];
let documents = [];
const imgDocuments = [];
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
				, '--no-sandbox'
				, '--incognito'
			],
			'ignoreHTTPSErrors': true
		});
	} catch (err) {
		console.log("Could not create a browser instance => : ", err);
	}
	return browser;
}

async function getInnerText(page, selector) {
	return await page.evaluate((selector) => {
		const element = document.querySelector(selector);
		return element ? element.innerText : '';
	}, selector)
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

const findBySelector = (page, selector, attribute) => page.evaluate((selector, attribute) => {
	const element = document.querySelector(selector)
	if (element) {
		return element.getAttribute(attribute)
	}
	return '';
}, selector, attribute);

function isNotVisited(url) {
	return !(url in visitedUrls);
}

async function fetchDocumentInfosPuppeteer(url) {
	const page = await browser.newPage();
	await page.setViewport({
		width: 900,
		height: 500,
		deviceScaleFactor: 0.25,
	});
	await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36');
	await page.setJavaScriptEnabled(true);

	//Mark visited
	visitedUrls[url] = 1;

	// Navigate to the page
	console.log(`Navigating to ${url}...`);
	await page.goto(url, {waitUntil: 'networkidle0'});
	sleep(10)
	// Wait for the required DOM to be rendered
	await page.waitForSelector('body');
	await page.waitForSelector('a');
	const body = await getInnerText(page, '*');
	const title = await page.title();
	const metaContent = await findBySelector(page, 'meta[name="description"', 'content')
	const header = await getInnerText(page, 'h1');
	// Get all the links
	const links = await page.$$eval('a', elements => {
		return elements.map(elem => elem.href).filter(l=>!l.endsWith('.pdf'));
	})
	const pdfLinks = await page.$$eval('a', elements => {
		return elements.filter(elem => elem.href.endsWith('.pdf')).map(a => ({
				url:a.href,
			}))
		});
	pdfLinks.filter(pl=>isValidURL(pl.url) && isNotVisited(pl.url))
		.forEach(pl => pdfQueue.push({
		...pl,
		parent:url
	}))

	const thumbnail = await page.screenshot({encoding: "base64", type: "jpeg", quality: 50})

	const document = {
		'url': url,
		'title': title,
		'body_content': body,
		'meta_description': metaContent,
		'header': header,
		'links': [...new Set(links.filter(l=>isValidURL(l)))],
		'thumbnail': thumbnail,
		'type': 'page'
	};
	const imgElems = await page.evaluate(() => Array.from(document.images, e => ({
		src: e.src,
		alt: e.alt
	})));
	if (imgElems)
		await imgElems.forEach(e => crawlImg(e, url))

	await page.close();
	return document;
}

async function crawlImg(elem, parentUrl) {
	if (!elem.src) return;
	if (imgDocuments.map(d => d.url).includes(elem.src)) return;
	imgDocuments.push({
		'url': elem.src,
		'title': elem.alt,
		'body_content': elem.alt,
		'meta_description': elem.alt,
		'header': elem.alt,
		'links': [parentUrl],
		'type': 'image'
	});
}

async function fetchDocumentInfosPDF(pdfLink) {
	const url = pdfLink.url;
	const parent = pdfLink.parent;
	visitedUrls[url] = 1;
	pdf2Html.html(url, (err, html) => {
		if (err) {
			console.error('Conversion error: ' + err);
		} else {
			const fileNameArr = url.split('/');
			const doc = {
				url,
				type: 'pdf',
				meta_description: '',
				body_content: html.replace(/(<([^>]+)>)/ig,""),
				link: [parent],
				title: fileNameArr[fileNameArr.length-1]
			};
			documents.push(doc);
		}
	});
}
async function scrapPDF(){
	if(pdfQueue.length === 0) {
		write('p_crawler.json');
		return;
	}
	const pdfLink = pdfQueue.shift();
	await fetchDocumentInfosPDF(pdfLink);
	await scrapPDF();
}
async function crawlNext() {
	if(pdfQueue.length>0) await scrapPDF();
	if (crawlQueue.length === 0) return;
	const queueItem = crawlQueue.shift();
	const level = queueItem.level;
	const url = queueItem.url;
	console.log('queue size:', crawlQueue.length, ' visited: ', Object.keys(visitedUrls).length, ' level: ', level, 'documents: ', documents.length);
	if (url.endsWith('.pdf')) {
		await fetchDocumentInfosPDF(url)
	} else if (level < maxLevel && isNotVisited(url)) {
		try {
			const doc = await fetchDocumentInfosPuppeteer(url);
			if (doc) {
				documents.push(doc);
				doc.links.forEach(link => {
					if (isValidURL(link))
						crawlQueue.push({
							url: link,
							level: level + 1
						})
				})
			}
		} catch (e) {
			console.log(e)
		}
	}
	await crawlNext();
}

startCrawl = async (url) => {
	browser = await startBrowser();
	try {
		crawlQueue.push({
			url: url,
			level: 0
		})
		crawlQueue.push({
			url: 'https://media.ford.com/content/fordmedia/fna/us/en/media-kits/2021/ford-pro.html',
			level: maxLevel - 1
		})
		await crawlNext();
		write('p_crawler.json');
		console.log(`Successfully crawled ${documents.length} pages`)
	} catch (e) {
		console.log('Error', e);
	}
	if (browser) browser.close();
	return 'complete';
}

const queryMatch = (doc, text) => Object.keys(doc)
	.filter(k => ['header', 'meta_description', 'body_content', 'title'].includes(k))
	.filter(k => (doc[k] || '').toLowerCase().includes(text))
	.length > 0;

const write = (file) => {
	console.log("saving file ", file);
	fs.writeFileSync(file, JSON.stringify([
		...documents,
		...imgDocuments
	], null, 4));
}
process.on('SIGINT', function () {
	console.log("Caught interrupt signal");
	console.log("Press y to backup data or x to exit");
	var stdin = process.stdin;
	stdin.resume();
	stdin.setEncoding('utf8');
	stdin.on('data', function (key) {
		if (key === '\u0003') {
			console.log('Press x to end');
			write('p_crawler_backup.json');
		}
		if (key.indexOf('y') == 0) {
			write('p_crawler_backup.json');
		} else if (key.indexOf('x') == 0) {
			process.exit();
		}
	});
});
app.listen(3001, async () => {
	console.log("web crawler server up");
});
app.get("/", (req, res) => {
	res.render('index.html');
})
app.get("/search", (req, res) => {
	let rawData = fs.readFileSync('p_crawler.json');
	if (rawData.length < 10)
		rawData = fs.readFileSync('p_crawler_backup.json');
	jsonData = JSON.parse(rawData);
	const docs = (req.query.type=='undefined')?
		jsonData:jsonData.filter(i=>i.type===req.query.type);
	res.json(docs.filter((d) => queryMatch(d, req.query.text.toLowerCase())))
})
app.get("/crawl", async (req, res) => {
	console.log('Started crawling')
	await startCrawl(req.param('url'));
	const msg = 'Crawled ' + documents.length + ' documents';
	console.log(msg)
	res.json({
		'message': msg
	});
});
