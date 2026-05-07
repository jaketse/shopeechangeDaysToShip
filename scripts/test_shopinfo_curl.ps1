param(
  [string]$SpcCds,
  [string]$CookieHeader
)

if (-not $SpcCds) { throw 'Missing -SpcCds' }
if (-not $CookieHeader) { throw 'Missing -CookieHeader' }

$url = "https://seller.shopee.tw/api/selleraccount/shop_info/?SPC_CDS=$SpcCds&SPC_CDS_VER=2"
$args = @(
  $url,
  '-H','authority: seller.shopee.tw',
  '-H','accept: application/json, text/plain, */*',
  '-H','accept-language: en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7',
  '-H',"cookie: $CookieHeader",
  '-H','dnt: 1',
  '-H','referer: https://seller.shopee.tw/portal/product/list/live/all?operationSortBy=recommend_v2',
  '-H','sc-fe-session: 7E419DD0C34B6065',
  '-H','sc-fe-ver: 21.146464',
  '-H','sec-ch-ua: "Not/A)Brand";v="8.0.0.0", "Google Chrome";v="117.0.5911.4", "Chromium";v="117.0.5911.4"',
  '-H','sec-ch-ua-mobile: ?0',
  '-H','sec-ch-ua-platform: "Windows"',
  '-H','sec-fetch-dest: empty',
  '-H','sec-fetch-mode: cors',
  '-H','sec-fetch-site: same-origin',
  '-H','user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.5911.4 Safari/537.36',
  '--silent','--show-error','--location'
)

$resp = & curl.exe @args
Write-Output $resp

