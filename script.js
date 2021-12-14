
// below this size all torrents will be completly downloaded.
const maxSizeToDownload = 52428800 //50MB
// change this if it's running inside a folder
const scope = '/'

// add default websocket trackers to speed up peer discovery
const defaultTorrentOpts = {
    announce: [
        "wss://tracker.btorrent.xyz",
        "wss://tracker.openwebtorrent.com"
    ]
}

// HTML elements
var $body = document.body
var $progressBar = document.querySelector('#progressBar')
var $numPeers = document.querySelector('#numPeers')
var $downloaded = document.querySelector('#downloaded')
var $total = document.querySelector('#total')
var $remaining = document.querySelector('#remaining')
var $uploadSpeed = document.querySelector('#uploadSpeed')
var $downloadSpeed = document.querySelector('#downloadSpeed')

const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);

const client = new WebTorrent({
    dht: {
        host: true,
    },
    utp: true,
});

const sw = navigator.serviceWorker.register(`sw.js`, { scope })

// start loading if we provide a magnet file or infoHash
if (urlParams.has('tid')) {
    const tid = urlParams.get('tid')
    addTorrent(tid)
}

document.querySelector('form').addEventListener('submit', function (e) {
    e.preventDefault()

    var torrentId = document.querySelector('form input[name=torrentId]').value
    addTorrent(torrentId)
})

function insertUrlParam(key, value) {
    if (history.pushState) {
        let searchParams = new URLSearchParams(window.location.search);
        searchParams.set(key, value);
        let newurl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?' + searchParams.toString();
        window.history.pushState({ path: newurl }, '', newurl);
    }
}


function addTorrent(tid) {
    client.add(tid, defaultTorrentOpts, async function (torrent) {
        await sw

        insertUrlParam("tid", tid)

        if (torrent.length > maxSizeToDownload) {
            console.log("torrent will be downloaded on demand", torrent.length)
            torrent.pause()
        }

        // Trigger statistics refresh
        torrent.on('done', onDone)
        setInterval(onProgress, 500)
        onProgress()

        // Statistics
        function onProgress() {
            // Peers
            $numPeers.innerHTML = torrent.numPeers + (torrent.numPeers === 1 ? ' peer' : ' peers')

            // Progress
            var percent = Math.round(torrent.progress * 100 * 100) / 100
            $progressBar.style.width = percent + '%'
            $downloaded.innerHTML = prettyBytes(torrent.downloaded)
            $total.innerHTML = prettyBytes(torrent.length)

            // Remaining time
            var remaining
            if (torrent.done) {
                remaining = 'Done.'
            } else {
                remaining = moment.duration(torrent.timeRemaining / 1000, 'seconds').humanize()
                remaining = remaining[0].toUpperCase() + remaining.substring(1) + ' remaining.'
            }
            $remaining.innerHTML = remaining

            // Speed rates
            $downloadSpeed.innerHTML = prettyBytes(torrent.downloadSpeed) + '/s'
            $uploadSpeed.innerHTML = prettyBytes(torrent.uploadSpeed) + '/s'
        }
        function onDone() {
            $body.className += ' is-seed'
            onProgress()
        }

        console.log("torrent added", torrent.infoHash, torrent.length)

        var iframe = document.getElementById("content")

        var src = ""
        if (urlParams.has('p')) {
            // instead of loading index, we try to load the specified path
            const path = urlParams.get('p')
            src = `${scope}webtorrent/${torrent.infoHash}/${encodeURI(path)}`
        } else {
            // TODO INDEX IS NOT ALWAYS THERE

            // Get index.html
            var indexFile = torrent.files.find(file => file.path === torrent.name + '/index.html')

            // start downloading as fast as possible.
            indexFile.select()

            console.log("index file", indexFile.path)

            src = `${scope}webtorrent/${torrent.infoHash}/${encodeURI(indexFile.path)}`//specified scope in source and encoded uri of filepath to fix some weird filenames
        }

        iframe.src = src

        var previousLocation = ""
        setInterval(function () {
            if (iframe.contentWindow.location.pathname == previousLocation) {
                return
            }
            previousLocation = iframe.contentWindow.location.pathname
            insertUrlParam("p", previousLocation.replace(`${scope}webtorrent/${torrent.infoHash}/`, ''))
        }, 1000)




    })
}

const pathRe = /\.([^.\/]+)$/;
function fileExt(path) {
    const res = pathRe.exec(path);
    return (res ? res[1] : undefined)
}

// Human readable bytes util
function prettyBytes(num) {
    var exponent, unit, neg = num < 0, units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
    if (neg) num = -num
    if (num < 1) return (neg ? '-' : '') + num + ' B'
    exponent = Math.min(Math.floor(Math.log(num) / Math.log(1000)), units.length - 1)
    num = Number((num / Math.pow(1000, exponent)).toFixed(2))
    unit = units[exponent]
    return (neg ? '-' : '') + num + ' ' + unit
}

function serveFile(file, req) {
    const res = {
        status: 200,
        headers: {
            'Content-Type': file._getMimeType(),
            // Support range-requests
            'Accept-Ranges': 'bytes'
        }
    }

    // force the browser to download the file if there is a specific header
    // if (req.headers.get('upgrade-insecure-requests') === '1') {
    //   res.headers['Content-Type'] = 'application/octet-stream'
    //   res.headers['Content-Disposition'] = 'attachment'
    // }

    // `rangeParser` returns an array of ranges, or an error code (number) if
    // there was an error parsing the range.
    let range = rangeParser(file.length, req.headers.get('range') || '')

    if (Array.isArray(range)) {
        res.status = 206 // indicates that range-request was understood

        // no support for multi-range request, just use the first range
        range = range[0]

        res.headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.length}`
        res.headers['Content-Length'] = `${range.end - range.start + 1}`
    } else {
        range = null
        res.headers['Content-Length'] = file.length
    }

    res.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
    res.headers.Expires = '0'

    res.body = req.method === 'HEAD' ? '' : 'stream'

    return [res, req.method === 'GET' && file.createReadStream(range)]
}

// kind of a fetch event from service worker but for the main thread.
navigator.serviceWorker.addEventListener('message', evt => {
    let [infoHash, ...filePath] = evt.data.url.split(evt.data.scope + 'webtorrent/')[1].split('/')
    filePath = decodeURI(filePath.join('/'))
    console.log("filepath", filePath)
    if (!infoHash || !filePath) return

    const torrent = client.get(infoHash)

    var file
    file = torrent.files.find(file => file.path === filePath)

    if (!file && !fileExt(filePath)) {
        // Try to find index.html file
        indexPath = decodeURI(filePath + 'index.html')
        console.log("trying to get index", indexPath)
        file = torrent.files.find(file => file.path === indexPath)
    }

    // TODO look for index.htm
    // TODO if requested filePath is not a file, list all folder content

    if (!file) {
        console.log("file not found", filePath)
        return
    }

    const [port] = evt.ports
    const [response, stream] = this.serveFile(file, new Request(evt.data.url, {
        headers: evt.data.headers,
        method: evt.data.method
    }))

    const asyncIterator = stream && stream[Symbol.asyncIterator]()
    port.postMessage(response)

    port.onmessage = async msg => {
        if (msg.data) {
            const chunk = (await asyncIterator.next()).value
            port.postMessage(chunk)
            if (!chunk) port.onmessage = null
        } else {
            console.log('closing stream')
            stream.destroy()
            port.onmessage = null
        }
    }
})
