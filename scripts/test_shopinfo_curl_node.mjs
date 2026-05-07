import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const spcCds = process.env.SPC_CDS;
const cookie = process.env.COOKIE_HEADER;
if (!spcCds || !cookie) {
  console.error('Need env: SPC_CDS and COOKIE_HEADER');
  process.exit(1);
}

const url = `https://seller.shopee.tw/api/selleraccount/shop_info/?SPC_CDS=${encodeURIComponent(spcCds)}&SPC_CDS_VER=2`;
const args = [
  url,
  '-H', 'authority: seller.shopee.tw',
  '-H', 'accept: application/json, text/plain, */*',
  '-H', 'accept-language: en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
  '-H', `cookie: ${cookie}`,
  '-H', 'dnt: 1',
  '-H', 'referer: https://seller.shopee.tw/portal/product/list/live/all?operationSortBy=recommend_v2',
  '-H', 'sc-fe-session: 7E419DD0C34B6065',
  '-H', 'sc-fe-ver: 21.146464',
  '-H', 'sec-ch-ua: "Not/A)Brand";v="8.0.0.0", "Google Chrome";v="117.0.5911.4", "Chromium";v="117.0.5911.4"',
  '-H', 'sec-ch-ua-mobile: ?0',
  '-H', 'sec-ch-ua-platform: "Windows"',
  '-H', 'sec-fetch-dest: empty',
  '-H', 'sec-fetch-mode: cors',
  '-H', 'sec-fetch-site: same-origin',
  '-H', 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.5911.4 Safari/537.36',
  '--silent', '--show-error', '--location'
];

const { stdout, stderr } = await execFileAsync('curl.exe', args, { maxBuffer: 10 * 1024 * 1024 });
if (stderr) process.stderr.write(stderr);
process.stdout.write(stdout);

