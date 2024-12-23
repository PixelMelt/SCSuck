const Soundcloud = require("soundcloud.ts")
const axios = require('axios');
const fs = require('fs')
const taglib = require('node-taglib-sharp')
// const cliProgress = require('cli-progress') // maybe later

const child_process = require('child_process');

const PouchDB = require('pouchdb');
PouchDB.plugin(require('pouchdb-find'));

const database = require("./database.js")

const config = require("./config.json");

makeDir("./DB")
const sdb = new PouchDB('./DB/SONG_DATABASE', {
    adapter: 'leveldb'
});
const adb = new PouchDB('./DB/ARTIST_DATABASE', {
    adapter: 'leveldb'
});

const soundcloud = new Soundcloud.default(config.clientId, config.oauthToken)


async function isValidAccount() {
    try {
        let user = await soundcloud.me.get()
        return user.id != null
    } catch (error) {
        return false
    }
}

function sanitizeTrack(name) {
    name = name.replace(/[\\/:*?\"\'\`<>|%$!#]/g, "") // same replacement as sc-ts %$!#
    return name
}

async function getBestCoverArt(track) {
    let cover = track.artwork_url ?? track.user.avatar_url // why?

    let coverBig = cover.replace("large.jpg", "t500x500.jpg")

    // check if 500x500 art exists by making an axios request
    let big;
    try {
        big = await axios.get(coverBig)
    } catch (error) {
        // console.error('Error getting cover art:', error.data)
        try {
            big = await axios.get(track.user.avatar_url) // cant go wrong with more trycatch :)
            big.status = "artist"
        } catch (error) {
            // ah darn, no more images
            big = {
                status: "noimage"
            }
        }
    }
    
    
    switch(big.status){
        case 200:
            track.coverUrl = coverBig
            break
        case "artist":
            track.coverUrl = track.user.avatar_url
            break
        case "noimage":
            track.coverUrl = "noimage"
            break
        default:
            track.coverUrl = cover
            break
    }

    return track.coverUrl
}

async function writeMetadata(track, trackPath, imagePath) {
    try {
        let file = taglib.File.createFromPath(trackPath)
        file.tag.albumArtists = [track.user.username]
        file.tag.album = track.found_album ? track.found_album : track.title

        file.tag.performers = [track.user.username]
        file.tag.title = track.title
        file.tag.year = new Date(track.created_at).getFullYear()
        file.tag.genres = [track.genre]
        file.tag.track = track.trackIndex + 1
        let cover = taglib.Picture.fromPath(imagePath)
        file.tag.pictures = [cover]
        file.save();
        file.dispose();
        return true
    } catch (error) {
        console.error('Error writing metadata:', error);
        return false
    }
}

async function downloadCover(url, outputFilePath) {
    if(url == "noimage") {
        // copy default image from ./src/noimage.jpg to location
        fs.copyFileSync("src/noimage.jpg", outputFilePath)
        return
    }
    try {
        // Download the PNG image
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream' // This is important to preserve binary data like images
        });

        // Create a write stream to save the file locally as 'outputFilePath'
        const writer = fs.createWriteStream(outputFilePath);

        // Pipe the response data into the file
        response.data.pipe(writer);

        // Return a promise that resolves when the writing is finished
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve); // resolve the promise when the file writing is done
            writer.on('error', reject); // reject the promise if there is an error
        });
    } catch (error) {
        console.error('Error downloading the file:', error.message);
    }
}

async function downloadTrack(track, album = false) {
    let trackNamePermalink = track.permalink
    let artistNamePermalink = track.user.permalink.replace(" ", "_")
    let albumNamePermalink = album ? album.permalink : trackNamePermalink

    let metaTrackName = sanitizeTrack(track.title)
    let metaArtistName = track.user.username
    let metaAlbumName = album ? sanitizeTrack(album.title) : metaTrackName

    // console.log(album)
    // console.log(track)
    // throw 2

    let scSongID = `${artistNamePermalink}/${trackNamePermalink}` // do not use this for saving

    let relativeSavePath = `${artistNamePermalink}/${albumNamePermalink}/${metaTrackName}`

    let artistDir = `${config.outputDir}/${artistNamePermalink}`
    let albumDir = `${config.outputDir}/${artistNamePermalink}/${albumNamePermalink}`
    
    makeDir(artistDir)
    makeDir(albumDir)

    // dont download again if we have it
    if (await database.musicExists(relativeSavePath, sdb)) {
        // console.log(`Track ${metaTrackName} by ${metaArtistName} already exists in database, skipping`)
        return "exists"
    }

    if(album){
        let albumcover = album.artwork_url ?? album.user.avatar_url
        try {
            await downloadCover(await getBestCoverArt(album), albumDir+"/cover.jpg")
        } catch (error) {
            console.error(`Error downloading cover for ${metaAlbumName} by ${metaArtistName}`)
            console.error(error)
        }
    }

    // console.log(`Downloading ${metaTrackName} on ${metaAlbumName} by ${metaArtistName}`)
    let downloadedFilePath;
    try {
        downloadedFilePath = await soundcloud.util.downloadTrack(scSongID, albumDir)
        // check if its actually there
        if (!fs.existsSync(downloadedFilePath)) {
            console.log(`Error downloading track ${metaTrackName} by ${metaArtistName}, not added to database`)
            return false
        }
    } catch (error) {
        console.error(error)
        return false
    }


    let fileType = downloadedFilePath.split(".")
    fileType = fileType[fileType.length - 1]

	switch (fileType) {
		case "flac":
        case "mp3":
            // console.log(`No re encode needed`)
            break;

        case "wav":
		case "aif":
		case "aiff":
        case "m4a": // i get the other two but m4a??
		case "ogg": // what the sigma??
		case "aac": // what the acc??
            
            // re encode to flac
            // console.log(`Downloaded uncompressed format, encoding to FLAC...`)
            let encoded = encodeToFlac(downloadedFilePath, `${albumDir}/${metaTrackName}.flac`)
            if (encoded) {
                // console.log(`Encoded to flac`)
                // delete original file
                fs.unlinkSync(downloadedFilePath)
                fileType = "flac"
            } else {
                console.log(`Error encoding ${metaTrackName} by ${metaArtistName} to flac, not added to database`)
                return
            }
            break;

        default:
            console.log(`Error downloading track ${metaTrackName} by ${metaArtistName}, unknown download format ${fileType}, not added to database`)
            return
    }

    // post metadata to db
    track.path = relativeSavePath
    track.ext = fileType
    track.found_album = album ? album.title : null
    track.trackIndex = album ? album.trackIndex : 0

    track.coverUrl = await getBestCoverArt(track)

    let coverimage = `${artistDir}/${metaTrackName}.jpg`

    await downloadCover(track.coverUrl, coverimage)

    let metaWritten = await writeMetadata(track, `${albumDir}/${metaTrackName}.${fileType}`, coverimage)
    // remove cover image
    fs.unlinkSync(coverimage)

    database.addSong(track, sdb)
}


function makeDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir)
    }
}


async function encodeToFlac(file, outfile) {
    // might want to add some sanitization here
    let cmd = `ffmpeg -i "${file}" -c:a flac "${outfile}"`
    // dont log
    child_process.execSync(cmd, {
        stdio: 'ignore'
    })

    if (fs.existsSync(outfile)) {
        return true
    } else {
        return false
    }
}

async function downloadArtist(artistName) {
    console.log(`Looking up ${artistName}'s albums`)

    // use this to correctly tag songs that are in albums
    let albums;
    try {
        albums = await soundcloud.users.albums(artistName)
    } catch (error) {
        console.log(`Error looking up ${artistName}'s albums`)
        albums = []
    }

    console.log(`Looking up ${artistName}'s tracks`)
    let artistSongs;
    let artistSc;
    try {
		artistSc = await soundcloud.users.get(artistName)
        artistSongs = await soundcloud.users.tracks(artistName)
    } catch (error) {
        console.error(error)
        console.log(`Error downloading ${artistName}'s tracks`)
        return false
    }

    // filter for item.user.permalink == artistName
    artistSongs = artistSongs.filter(item => item.user.permalink == artistName)

    // let songsbar;
    // if(artistSongs.length > 0) {
    //     songsbar = new cliProgress.SingleBar({
    //         format: '{artname} | {bar} | {percentage}% | {songname} | {value}/{total} tracks',
    //         barCompleteChar: '\u2588',
    //         barIncompleteChar: '\u2591',
    //         clearOnComplete: true,
    //         hideCursor: false
    //     });
    //     songsbar.start(artistSongs.length + 1, 0);
    // }

    let index = 0
    for (let song of artistSongs) {

        // find out if the track is in an album
        let album = false
        for(let alb of albums) {
            if (alb.tracks.some(track => track.id == song.id)) {
                album = alb
                album.trackIndex = alb.tracks.findIndex(track => track.id == song.id)
                break
            }
        }

        // songsbar.update(index++, {songname: song.title, artname: artistName})

        // console.log(`Downloading ${artistName} track ${++index} of ${artistSongs.length}`)

        let songstat = await downloadTrack(song, album)

        // Add delay before next download
        if (index < artistSongs.length - 1) { // Don't wait after the last song
            await new Promise(resolve => setTimeout(resolve, config.rateLimitMS))
        }
    }

	// add to artist db
	await database.addArtist(artistSc, adb)

    // destroy the prog bar
    // if(songsbar) songsbar.stop()
}

async function downloadAllArtists() {
    try {
        // Get all documents from the artist database
        const result = await adb.allDocs({
            include_docs: true
        });

        // Extract the permalinks from the documents
        const artistPermalinks = result.rows.map(row => row.doc.permalink);

        console.log(`Found ${artistPermalinks.length} artists in the database.`);

        // Download tracks for each artist
        for (let i = 0; i < artistPermalinks.length; i++) {
            const permalink = artistPermalinks[i];
            console.log(`Processing artist ${i + 1} of ${artistPermalinks.length}: ${permalink}`);
            await downloadArtist(permalink);
        }

        console.log("Finished downloading tracks for all artists in the database.");
    } catch (error) {
        console.error("Error downloading all artists:", error);
    }
}


async function syncFollowing(userperma){
    try {
        console.log(`Looking up who ${userperma} is following`)     

        let following = await soundcloud.users.following(userperma)
        // console.log(following)
        for (let user of following) {
            await downloadArtist(user.permalink)
        }
    } catch (error) {
        console.error(error)
        console.log(`Error syncing ${userperma}'s following`)
        return false
    }
}

async function parseAndExecute(args, options) {
    const parsedArgs = {};
    const shorthandMap = {};

    // Create a map of shorthand to full argument names
    Object.keys(options).forEach(key => {
        if (options[key].shorthand) {
            shorthandMap[options[key].shorthand] = key;
        }
    });
    for (let i = 2; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--")) {
            const key = arg.slice(2);
            if (options[key]) {
                if (options[key].hasValue) {
                    parsedArgs[key] = args[++i];
                } else {
                    parsedArgs[key] = true;
                }
            }
        } else if (arg.startsWith("-")) {
            const shorthand = arg.slice(1);
            if (shorthandMap[shorthand]) {
                const key = shorthandMap[shorthand];
                if (options[key].hasValue) {
                    parsedArgs[key] = args[++i];
                } else {
                    parsedArgs[key] = true;
                }
            }
        }
    }

    // Execute functions for parsed arguments
    Object.keys(parsedArgs).forEach(async function(key) {
        if (options[key] && options[key].func) {
            await options[key].func(parsedArgs[key]);
        }
    });
    return parsedArgs;
}

function displayHelp(options) {
    console.log("Available commands:");
    Object.keys(options).forEach(key => {
        const option = options[key];
        const shorthand = option.shorthand ? `-${option.shorthand}, ` : "    ";
        const valueHint = option.hasValue ? " <value>" : "";
        console.log(`  ${shorthand}--${key}${valueHint}\t${option.description}`);
    });
}

const options = {
    help: {
        shorthand: "h",
        description: "Display help information",
        func: () => displayHelp(options)
    },
	version: {
		shorthand: "v",
		description: "Show the version number",
		func: () => console.log("Version 1.0.0")
	},
    artist: {
        shorthand: "a",
        hasValue: true,
        description: "Download all tracks by an artist",
        func: value => downloadArtist(value)
    },
    addFollowing: {
        shorthand: "f",
        hasValue: true,
        description: "Download all tracks by all artists that a user is following",
        func: value => syncFollowing(value)
    },
	refresh: {
        shorthand: "r",
        description: "Download new tracks for all artists in the database",
        func: () => downloadAllArtists()
    },
};

async function main() {

    try {
        await database.createSearchIndex(sdb)
    } catch (err) {
        if(err.toString().includes("lock")){
			console.error("Database seems to be unreadable (likely in use by another program).");
			return
		}
		console.error('Error creating index:', err);
    }
    makeDir(config.outputDir)

    let valid = await isValidAccount()
    if(!valid){
        console.log("Invalid Soundcloud account, please check your credentials")
        return
    }

    let parsedArgs = await parseAndExecute(process.argv, options)

    // If no arguments were provided, display help
    if (Object.keys(parsedArgs).length === 0) {
        displayHelp(options);
    }
}

main()