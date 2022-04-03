import fetch from 'node-fetch';
import getPixels from "get-pixels";
import WebSocket from 'ws';

const BASE_URL = "placefrance.noan.dev";
const VERSION_NUMBER = 1;

console.log(`PlaceNL headless client V${VERSION_NUMBER}`);

const args = process.argv.slice(2);

if (args.length != 1 && !process.env.ACCESS_TOKEN) {
    console.error("Token d'accès manquant")
    process.exit(1);
}

let accessTokens = (process.env.ACCESS_TOKEN || args[0]).split(',');
let defaultAccessToken = accessTokens[0];

if (accessTokens.length > 4) {
    console.warn("Plus de 4 comptes reddit par adresse IP n'est pas recommandé !")
}

var socket;
var currentOrders;
var currentOrderList;

const COLOR_MAPPINGS = {
	'#BE0039': 1,
    '#FF4500': 2,
    '#FFA800': 3,
    '#FFD635': 4,
    '#00A368': 6,
    '#00CC78': 7,
    '#7EED56': 8,
    '#00756F': 9,
    '#009EAA': 10,
    '#2450A4': 12,
    '#3690EA': 13,
    '#51E9F4': 14,
    '#493AC1': 15,
    '#6A5CFF': 16,
    '#811E9F': 18,
    '#B44AC0': 19,
    '#FF3881': 22,
    '#FF99AA': 23,
    '#6D482F': 24,
    '#9C6926': 25,
    '#000000': 27,
    '#898D90': 29,
    '#D4D7D9': 30,
    '#FFFFFF': 31
};

let rgbaJoin = (a1, a2, rowSize = 1000, cellSize = 4) => {
    const rawRowSize = rowSize * cellSize;
    const rows = a1.length / rawRowSize;
    let result = new Uint8Array(a1.length + a2.length);
    for (var row = 0; row < rows; row++) {
        result.set(a1.slice(rawRowSize * row, rawRowSize * (row+1)), rawRowSize * 2 * row);
        result.set(a2.slice(rawRowSize * row, rawRowSize * (row+1)), rawRowSize * (2 * row + 1));
    }
    return result;
};

let getRealWork = rgbaOrder => {
    let order = [];
    for (var i = 0; i < 2000000; i++) {
        if (rgbaOrder[(i * 4) + 3] !== 0) {
            order.push(i);
        }
    }
    return order;
};

let getPendingWork = (work, rgbaOrder, rgbaCanvas) => {
    let pendingWork = [];
    for (const i of work) {
        if (rgbaOrderToHex(i, rgbaOrder) !== rgbaOrderToHex(i, rgbaCanvas)) {
            pendingWork.push(i);
        }
    }
    return pendingWork;
};

(async function () {
	connectSocket();

    // Try to stagger pixel placement
    const interval = 300 / accessTokens.length;
    var delay = 0;
    for (const accessToken of accessTokens) {
        setTimeout(() => attemptPlace(accessToken), delay * 1000);
        delay += interval;
    }

    setInterval(() => {
        if (socket) socket.send(JSON.stringify({ type: 'ping' }));
    }, 5000);
})();

function connectSocket() {
    console.log("R/PlaceFRANCE !!! Connection...");


    socket = new WebSocket(`wss://${BASE_URL}/api/ws`);

    socket.onerror = function(e) {
        console.error("Erreur socket: " + e.message)
    }

    socket.onopen = function () {

        console.log('R/PlaceFRANCE !!! Connecté !');

        socket.send(JSON.stringify({ type: 'getmap' }));
        socket.send(JSON.stringify({ type: 'brand', brand: `nodeheadlessV${VERSION_NUMBER}` }));
    };

    socket.onmessage = async function (message) {
        var data;
        try {
            data = JSON.parse(message.data);
        } catch (e) {
            return;
        }

        switch (data.type.toLowerCase()) {
            case 'map':
                console.log(`Nouvelle map chargée (raison: ${data.reason ? data.reason : 'connecté au serveur'})`)
                currentOrders = await getMapFromUrl(`https://${BASE_URL}/maps/${data.data}`);
                currentOrderList = getRealWork(currentOrders.data);
                break;
            default:
                break;
        }
    };

    socket.onclose = function (e) {
        console.warn(`Le serveur PlaceFR s'est déconnecté :${e.reason}`)
        console.error('Erreur socket: ', e.reason);
        socket.close();
        setTimeout(connectSocket, 1000);
    };
}

async function attemptPlace(accessToken) {
    let retry = () => attemptPlace(accessToken);
    if (currentOrderList === undefined) {
        setTimeout(retry, 2000); // probeer opnieuw in 2sec.
        return;
    }
    
    var map0;
    var map1;
    try {
        map0 = await getMapFromUrl(await getCurrentImageUrl('0'))
        map1 = await getMapFromUrl(await getCurrentImageUrl('1'));
    } catch (e) {
        console.warn('Erreur lors de la récupération de la map: ', e);
        setTimeout(retry, 15000); // probeer opnieuw in 15sec.
        return;
    }

    const rgbaOrder = currentOrders.data;
    const rgbaCanvas = rgbaJoin(map0.data, map1.data);
    const work = getPendingWork(currentOrderList, rgbaOrder, rgbaCanvas);

    if (work.length === 0) {
        console.log(`Tous les pixels sont déjà à la bonne place ! Essayez à nouveau dans 30 secondes...`);
        setTimeout(retry, 30000); // probeer opnieuw in 30sec.
        return;
    }

    const percentComplete = 100 - Math.ceil(work.length * 100 / currentOrderList.length);
    const idx = Math.floor(Math.random() * work.length);
    const i = work[idx];
    const x = i % 2000;
    const y = Math.floor(i / 2000);
    const hex = rgbaOrderToHex(i, rgbaOrder);

    console.log(`Essaye de placer un pixel sur ${x}, ${y}... (${percentComplete}% complété)`);

    const res = await place(x, y, COLOR_MAPPINGS[hex], accessToken);
    const data = await res.json();
    try {
        if (data.errors) {
            const error = data.errors[0];
            const nextPixel = error.extensions.nextAvailablePixelTs + 3000;
            const nextPixelDate = new Date(nextPixel);
            const delay = nextPixelDate.getTime() - Date.now();
            console.log(`Pixel placé trop vite ! Le pixel suivant est placé à ${nextPixelDate.toLocaleTimeString()}.`)
            setTimeout(retry, delay);
        } else {
            const nextPixel = data.data.act.data[0].data.nextAvailablePixelTimestamp + 3000;
            const nextPixelDate = new Date(nextPixel);
            const delay = nextPixelDate.getTime() - Date.now();
            console.log(`Pixel placé sur ${x}, ${y}! Le pixel suivant sera placé à ${nextPixelDate.toLocaleTimeString()}.`)
            setTimeout(retry, delay);
        }
    } catch (e) {
        console.warn('Erreur d\'analyse de la réponse', e);
        setTimeout(retry, 10000);
    }
}

function place(x, y, color, accessToken = defaultAccessToken) {
    socket.send(JSON.stringify({ type: 'placepixel', x, y, color }));
    console.log("Placement du pixel à (" + x + ", " + y + ") avec la couleur: " + color)
	return fetch('https://gql-realtime-2.reddit.com/query', {
		method: 'POST',
		body: JSON.stringify({
			'operationName': 'setPixel',
			'variables': {
				'input': {
					'actionName': 'r/replace:set_pixel',
					'PixelMessageData': {
						'coordinate': {
							'x': x % 1000,
							'y': y % 1000
						},
						'colorIndex': color,
						'canvasIndex': (x > 999 ? 1 : 0)
					}
				}
			},
			'query': 'mutation setPixel($input: ActInput!) {\n  act(input: $input) {\n    data {\n      ... on BasicMessage {\n        id\n        data {\n          ... on GetUserCooldownResponseMessageData {\n            nextAvailablePixelTimestamp\n            __typename\n          }\n          ... on SetPixelResponseMessageData {\n            timestamp\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n'
		}),
		headers: {
			'origin': 'https://hot-potato.reddit.com',
			'referer': 'https://hot-potato.reddit.com/',
			'apollographql-client-name': 'mona-lisa',
			'Authorization': `Bearer ${accessToken}`,
			'Content-Type': 'application/json'
		}
	});
}

async function getCurrentImageUrl(id = '0') {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket('wss://gql-realtime-2.reddit.com/query', 'graphql-ws', {
        headers : {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:98.0) Gecko/20100101 Firefox/98.0",
            "Origin": "https://hot-potato.reddit.com"
        }
      });

		ws.onopen = () => {
			ws.send(JSON.stringify({
				'type': 'connection_init',
				'payload': {
					'Authorization': `Bearer ${defaultAccessToken}`
				}
			}));

			ws.send(JSON.stringify({
				'id': '1',
				'type': 'start',
				'payload': {
					'variables': {
						'input': {
							'channel': {
								'teamOwner': 'AFD2022',
								'category': 'CANVAS',
								'tag': id
							}
						}
					},
					'extensions': {},
					'operationName': 'replace',
					'query': 'subscription replace($input: SubscribeInput!) {\n  subscribe(input: $input) {\n    id\n    ... on BasicMessage {\n      data {\n        __typename\n        ... on FullFrameMessageData {\n          __typename\n          name\n          timestamp\n        }\n      }\n      __typename\n    }\n    __typename\n  }\n}'
				}
			}));
		};

		ws.onmessage = (message) => {
			const { data } = message;
			const parsed = JSON.parse(data);

            if (parsed.type === 'connection_error') {
                console.error(`[!!] Impossible de charger la map /r/place: ${parsed.payload.message}. Le jeton d'accès n'est plus valide ?`);
            }

			// TODO: ew
			if (!parsed.payload || !parsed.payload.data || !parsed.payload.data.subscribe || !parsed.payload.data.subscribe.data) {
                console.log(payload);
            };

			ws.close();
			resolve(parsed.payload.data.subscribe.data.name + `?noCache=${Date.now() * Math.random()}`);
		}


		ws.onerror = reject;
	});
}

function getMapFromUrl(url) {
    return new Promise((resolve, reject) => {
        getPixels(url, function(err, pixels) {
            if(err) {
                console.log("Mauvais chemin vers l'image")
                reject()
                return
            }
            console.log("Pixels récupérés", pixels.shape.slice())
            resolve(pixels)
        })
    });
}

function rgbToHex(r, g, b) {
	return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

let rgbaOrderToHex = (i, rgbaOrder) =>
    rgbToHex(rgbaOrder[i * 4], rgbaOrder[i * 4 + 1], rgbaOrder[i * 4 + 2]);
