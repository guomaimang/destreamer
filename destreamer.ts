import { BrowserTests } from './BrowserTests';
import { TokenCache } from './TokenCache';
import { Metadata, getVideoMetadata } from './Metadata';

import { execSync } from 'child_process';
import puppeteer from 'puppeteer';
import { terminal as term } from 'terminal-kit';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';
import sanitize from 'sanitize-filename';

/**
 * exitCode 25 = cannot split videoID from videUrl
 * exitCode 27 = no hlsUrl in the API response
 * exitCode 29 = invalid response from API
 * exitCode 88 = error extracting cookies
 */

let tokenCache = new TokenCache();

const argv = yargs.options({
    videoUrls: { type: 'array', alias: 'videourls', demandOption: true },
    username: { type: 'string', demandOption: false },
    outputDirectory: { type: 'string', alias: 'outputdirectory', default: 'videos' },
    format: {
        alias:"f",
        describe: `Expose youtube-dl --format option, for details see\n
        https://github.com/ytdl-org/youtube-dl/blob/master/README.md#format-selection`,
        type:'string',
        demandOption: false
    },
    simulate: {
        alias: "s",
        describe: `If this is set to true no video will be downloaded and the script
        will log the video info (default: false)`,
        type: "boolean",
        default: false,
        demandOption: false
    },
    verbose: {
        alias: "v",
        describe: `Print additional information to the console
        (use this before opening an issue on GitHub)`,
        type: "boolean",
        default: false,
        demandOption: false
    }
}).argv;

if (argv.simulate){
    console.info('Video URLs: %s', argv.videoUrls);
    console.info('Username: %s', argv.username);
    term.blue("There will be no video downloaded, it's only a simulation\n");
} else {
    console.info('Video URLs: %s', argv.videoUrls);
    console.info('Username: %s', argv.username);
    console.info('Output Directory: %s', argv.outputDirectory);
    console.info('Video/Audio Quality: %s', argv.format);
}


function sanityChecks() {
    try {
        const ytdlVer = execSync('youtube-dl --version');
        term.green(`Using youtube-dl version ${ytdlVer}`);
    }
    catch (e) {
        console.error('You need youtube-dl in $PATH for this to work. Make sure it is a relatively recent one, baked after 2019.');
        process.exit(22);
    }

    try {
        const ffmpegVer = execSync('ffmpeg -version')
            .toString().split('\n')[0];
        term.green(`Using ${ffmpegVer}\n`);
    }
    catch (e) {
        console.error('FFmpeg is missing. You need a fairly recent release of FFmpeg in $PATH.');
    }

    if (!fs.existsSync(argv.outputDirectory)){
        console.log('Creating output directory: ' +
            process.cwd() + path.sep + argv.outputDirectory);
        fs.mkdirSync(argv.outputDirectory);
    }
}


async function DoInteractiveLogin(username?: string) {
    console.log('Launching headless Chrome to perform the OpenID Connect dance...');
    const browser = await puppeteer.launch({
        headless: false,
        args: ['--disable-dev-shm-usage']
    });
    const page = (await browser.pages())[0];
    console.log('Navigating to microsoftonline.com login page...');

    // This breaks on slow connections, needs more reliable logic
    await page.goto('https://web.microsoftstream.com', { waitUntil: "networkidle2" });
    await page.waitForSelector('input[type="email"]');
    
    if (username) {
        await page.keyboard.type(username);
        await page.click('input[type="submit"]');
    }

    await browser.waitForTarget(target => target.url().includes('microsoftstream.com/'), { timeout: 90000 });
    console.log('We are logged in.');
    // We may or may not need to sleep here.
    // Who am i to deny a perfectly good nap?
    await sleep(1500);

    console.log('Got cookie. Consuming cookie...');
    
    await sleep(4000);
    console.log("Calling Microsoft Stream API...");
    
    let cookie = await exfiltrateCookie(page);

    let sessionInfo: any;
    let session = await page.evaluate(
        () => {
            return { 
                AccessToken: sessionInfo.AccessToken,
                ApiGatewayUri: sessionInfo.ApiGatewayUri,
                ApiGatewayVersion: sessionInfo.ApiGatewayVersion,
                Cookie: cookie
            };
        }
    );
        
    tokenCache.Write(session.AccessToken);
    console.log("Wrote access token to token cache.");

    console.log(`ApiGatewayUri: ${session.ApiGatewayUri}`);
    console.log(`ApiGatewayVersion: ${session.ApiGatewayVersion}`);

    console.log("At this point Chromium's job is done, shutting it down...");
    await browser.close();

    return session;
}


function extractVideoGuid(videoUrls: string[]): string[] {
    let videoGuids: string[] = [];
    let guid: string = "";
    for (let url of videoUrls) {
        try {
            let guid = url.split('/').pop();
        }
        catch (e)
        {
            console.error(`Could not split the video GUID from URL: ${e.message}`);
            process.exit(25);
        }
        videoGuids.push(guid);
    }
    
    return videoGuids;
}


async function rentVideoForLater(videoUrls: string[], outputDirectory: string, session: object) {
    const videoGuids = extractVideoGuid(videoUrls);
    let accessToken = null;
    try {
        accessToken = tokenCache.Read();
    }
    catch (e)
    {
        console.log("Cache is empty or expired, performing interactive log on...");
    }

    console.log("Fetching title and HLS URL...");
    let metadata: Metadata[] = await getVideoMetadata(videoGuids, session);

    metadata.forEach(video => {
        video.title = sanitize(video.title);
        term.blue(`Video Title: ${video.title}`);

        console.log('Spawning youtube-dl with cookie and HLS URL...');
        const format = argv.format ? `-f "${argv.format}"` : "";
        var youtubedlCmd = 'youtube-dl --no-call-home --no-warnings ' + format +
                ` --output "${outputDirectory}/${video.title}.mp4" --add-header ` +
                `Cookie:"${session.AccessToken}" "${video.playbackUrl}"`;

        if (argv.simulate) {
            youtubedlCmd = youtubedlCmd + " -s";
        }

        if (argv.verbose) {
            console.log(`\n\n[VERBOSE] Invoking youtube-dl:\n${youtubedlCmd}\n\n`);
        }
        execSync(youtubedlCmd, { stdio: 'inherit' });
    }
}


function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


async function exfiltrateCookie(page: puppeteer.Page) {
    var jar = await page.cookies("https://.api.microsoftstream.com");
    var authzCookie = jar.filter(c => c.name === 'Authorization_Api')[0];
    var sigCookie = jar.filter(c => c.name === 'Signature_Api')[0];

    if (authzCookie == null || sigCookie == null) {
        await sleep(5000);
        var jar = await page.cookies("https://.api.microsoftstream.com");
        var authzCookie = jar.filter(c => c.name === 'Authorization_Api')[0];
        var sigCookie = jar.filter(c => c.name === 'Signature_Api')[0];
    }

    if (authzCookie == null || sigCookie == null) {
        console.error('Unable to read cookies. Try launching one more time, this is not an exact science.');
        process.exit(88);
    }

    return `Authorization=${authzCookie.value}; Signature=${sigCookie.value}`;
}


// We should probably use Mocha or something
const args: string[] = process.argv.slice(2);
if (args[0] === 'test')
{
    BrowserTests();
}

else {
    sanityChecks();
    rentVideoForLater(argv.videoUrls as string[], argv.outputDirectory, argv.username);
}
