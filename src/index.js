const Soundcloud = require("soundcloud.ts")
const axios = require('axios');
const cp = require('child_process')
const fs = require('fs')

const config = require("./config.json")
const soundcloud = new Soundcloud.default(config.clientId, config.oauthToken)


function dlpCommandGen(hifi){
	let yt_dlp_cmd = "yt-dlp -x -f 'bestaudio/best' --add-metadata"

	if(hifi){
		yt_dlp_cmd.concat(" --audio-format flac")
	} else{
		yt_dlp_cmd.concat(" --audio-format mp3 --audio-quality 320k")
	}
}

async function isValidAccount() {
	let user = await soundcloud.me.get()
	return user.id != null
}

async function downloadTrack(artistName, trackName){
	let track = soundcloud.tracks.get(`${artistName}/${trackName}`)
	if(track.downloadable && track.has_downloads_left){ // dunno what has_downloads_left is but we probably want it
		
	}
	// not hifi

}

// function to create artist directory
function createArtistDir(artist) {
	if(!fs.existsSync(`${config.outputDir}/${artist}`)) {
		fs.mkdirSync(`${config.outputDir}/${artist}`)
	}
}