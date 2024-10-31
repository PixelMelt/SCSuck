async function createSearchIndex(db) {
	await db.createIndex({
		index: {
			fields: ['title', 'artist', 'album']
		}
	}).catch(err => console.error('Error creating search index:', err));

	await db.createIndex({
        index: {
            fields: ['path']  // Dedicated index only for 'id'
        }
    }).catch(err => console.error('Error creating path index:', err));
}

async function searchMusic(query, db) {
	try{
		const result = await db.find({
			selector: {
				$or: [
					{ title: { $regex: query } },
					{ artist: { $regex: query } },
					{ album: { $regex: query } }
				]
			},
			limit: 20 // Limit results to 20 items
		});
		
		return result.docs;
	} catch (error) {
		console.error('Search error:', error);
		throw error;
	}
}

// function to make sure its not downloading again
async function musicExists(path, db){
	let result = await db.find({
		selector: {
            path: { $eq: path }
        }
	}).catch(err => console.error('Error checking if music exists:', err));
	// console.log(result)
	if(result.docs.length > 0){
		return true
	}
	return false
}

async function addSong(data, db){
	// filter out most things

	let song = {
		id: data.id,
		created_at: data.created_at,
		genre: data.genre,
		tag_list: data.tag_list,
		user_id: data.user_id, // number
		trackIndex: data.trackIndex,
		
		description: data.description,

		title: data.title, // song title, crazy unicodes
		s_permalink: data.permalink, // song name, normal

		username: data.user.username, // artist name, unicodes
		a_permalink: data.user.permalink, // artist name, normal
		
		path: data.path, // path on disk
		ext: data.ext, // file extension
		version: 1 // program version
	}

	let push = await db.post(song).catch(err => console.error('Error adding song:', err));
	if(push){
		// console.log('Added song to database:', song.title);
		return true
	}
	return false
}

async function addArtist(data, db) {
    let artist = {
        _id: data.permalink, // Use permalink as the document _id
        avatar_url: data.avatar_url,
        created_at: data.created_at,
        description: data.description,
        id: data.id,
        last_modified: data.last_modified,
        permalink: data.permalink,
        track_count: data.track_count,
        username: data.username
    };

    try {
        // Try to get the existing document
        const existingDoc = await db.get(artist._id).catch(() => null);

        if (!existingDoc) {
            await db.put(artist);
		}
		
        return true;
    } catch (err) {
        console.error('Error adding/updating artist:', err);
        return false;
    }
}


module.exports = {
	createSearchIndex,
	searchMusic,
	addSong,
	addArtist,
	musicExists
}