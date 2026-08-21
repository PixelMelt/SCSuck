TRACK OBJECT:
{
	"artwork_url": "https://i1.sndcdn.com/artworks-lQf0AAPDzgoIzIup-SubyKw-large.jpg",
	"caption": null,
	"commentable": true,
	"comment_count": 30,
	"created_at": "2024-04-24T22:49:47Z",
	"description": "u just like 2 talk real loud now. 🗣️🙄",
	"downloadable": false,
	"download_count": 0,
	"duration": 113424,
	"full_duration": 113424,
	"embeddable_by": "all",
	"genre": "meatbop",
	"has_downloads_left": false,
	"id": 1807325826,
	"kind": "track",
	"label_name": null,
	"last_modified": "2024-05-29T14:39:12Z",
	"license": "all-rights-reserved",
	"likes_count": 287,
	"permalink": "down-in-the-dm",
	"permalink_url": "https://soundcloud.com/meet1020/down-in-the-dm",
	"playback_count": 10230,
	"public": true,
	"publisher_metadata": {
		"id": 1807325826,
		"urn": "soundcloud:tracks:1807325826",
		"contains_music": true
	},
	"purchase_title": null,
	"purchase_url": null,
	"release_date": null,
	"reposts_count": 21,
	"secret_token": null,
	"sharing": "public",
	"state": "finished",
	"streamable": true,
	"tag_list": "dariacore",
	"title": "down in the dm",
	"uri": "https://api.soundcloud.com/tracks/1807325826",
	"urn": "soundcloud:tracks:1807325826",
	"user_id": 1229940244,
	"visuals": null,
	"waveform_url": "https://wave.sndcdn.com/q5IowznAbLiC_m.json",
	"display_date": "2024-04-24T22:49:47Z",
	"media": {
		"transcodings": [
			{
				"url": "https://api-v2.soundcloud.com/media/soundcloud:tracks:1807325826/537f5ae3-bd86-41bf-91e0-fb6d7281b93b/stream/hls",
				"preset": "mp3_1_0",
				"duration": 113424,
				"snipped": false,
				"format": {
					"protocol": "hls",
					"mime_type": "audio/mpeg"
				},
				"quality": "sq",
				"is_legacy_transcoding": true
			},
			{
				"url": "https://api-v2.soundcloud.com/media/soundcloud:tracks:1807325826/537f5ae3-bd86-41bf-91e0-fb6d7281b93b/stream/progressive",
				"preset": "mp3_1_0",
				"duration": 113424,
				"snipped": false,
				"format": {
					"protocol": "progressive",
					"mime_type": "audio/mpeg"
				},
				"quality": "sq",
				"is_legacy_transcoding": true
			},
			{
				"url": "https://api-v2.soundcloud.com/media/soundcloud:tracks:1807325826/cef4b792-fac6-4a08-bbf7-0827a2f77f8d/stream/hls",
				"preset": "opus_0_0",
				"duration": 113389,
				"snipped": false,
				"format": {
					"protocol": "hls",
					"mime_type": "audio/ogg; codecs=\"opus\""
				},
				"quality": "sq",
				"is_legacy_transcoding": true
			}
		]
	},
	"station_urn": "soundcloud:system-playlists:track-stations:1807325826",
	"station_permalink": "track-stations:1807325826",
	"track_authorization": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW8iOiJVUyIsInN1YiI6IjEyMTk5NzE0NDgiLCJyaWQiOiI4MGEyMzUxYi1jMDQyLTRlMTgtOTdiNi02ODEzYjczMjRjNzAiLCJpYXQiOjE3NDA4MDY3MTR9.bWnxFjOv-A5B85IMR9buzEAaO_GErKLT5rbEEA-TZTA",
	"monetization_model": "BLACKBOX",
	"policy": "MONETIZE",
	"user": {
		"avatar_url": "https://i1.sndcdn.com/avatars-UHhgPgLPA0z5rMBs-rrFrgA-large.jpg",
		"first_name": "",
		"followers_count": 603,
		"full_name": "",
		"id": 1229940244,
		"kind": "user",
		"last_modified": "2024-09-16T07:20:18Z",
		"last_name": "",
		"permalink": "meet1020",
		"permalink_url": "https://soundcloud.com/meet1020",
		"uri": "https://api.soundcloud.com/users/1229940244",
		"urn": "soundcloud:users:1229940244",
		"username": "meet",
		"verified": false,
		"city": "",
		"country_code": null,
		"badges": {
			"pro": false,
			"creator_mid_tier": false,
			"pro_unlimited": false,
			"verified": false
		},
		"station_urn": "soundcloud:system-playlists:artist-stations:1229940244",
		"station_permalink": "artist-stations:1229940244"
	}
},


export interface SoundcloudTrack {
    comment_count: number
    full_duration: number
    downloadable: boolean
    created_at: string
    description: string | null
    media: {
        transcodings: SoundcloudTranscoding[]
    }
    title: string
    publisher_metadata: {
        urn: string
        contains_music: boolean
        id: number
    }
    duration: number
    has_downloads_left: boolean
    artwork_url: string
    public: boolean
    streamable: boolean
    tag_list: string
    genre: string
    id: number
    reposts_count: number
    state: "processing" | "failed" | "finished"
    label_name: string | null
    last_modified: string
    commentable: boolean
    policy: string
    visuals: string | null
    kind: string
    purchase_url: string | null
    sharing: "private" | "public"
    uri: string
    secret_token: string | null
    download_count: number
    likes_count: number
    urn: string
    license: SoundcloudLicense
    purchase_title: string | null
    display_date: string
    embeddable_by: "all" | "me" | "none"
    release_date: string
    user_id: number
    monetization_model: string
    waveform_url: string
    permalink: string
    permalink_url: string
    user: SoundcloudUser
    playback_count: number
}

USER OBJECT:
{
  avatar_url: 'https://i1.sndcdn.com/avatars-JdSBIP4BToyUN2lN-fSMxnQ-large.jpg',
  city: 'Portland, OR',
  comments_count: 0,
  country_code: 'US',
  created_at: '2013-05-06T19:47:39Z',
  creator_subscriptions: [ { product: [Object] } ],
  creator_subscription: { product: { id: 'creator-pro-unlimited' } },
  description: 'it/she',
  followers_count: 9649,
  followings_count: 697,
  first_name: 'Zelda',
  full_name: 'Zelda Lulamoon',
  groups_count: 0,
  id: 43969708,
  kind: 'user',
  last_modified: '2025-01-31T00:44:45Z',
  last_name: 'Lulamoon',
  likes_count: 3591,
  playlist_likes_count: 51,
  permalink: 'vyletpony',
  permalink_url: 'https://soundcloud.com/vyletpony',
  playlist_count: 15,
  reposts_count: null,
  track_count: 275,
  uri: 'https://api.soundcloud.com/users/43969708',
  urn: 'soundcloud:users:43969708',
  username: 'Vylet Pony',
  verified: true,
  visuals: {
    urn: 'soundcloud:users:43969708',
    enabled: true,
    visuals: [
		{
			urn: 'soundcloud:users:43969708',
			enabled: true,
			visuals: [
				{
				urn: 'soundcloud:visuals:229349760',
				entry_time: 0,
				visual_url: 'https://i1.sndcdn.com/visuals-000043969708-YRjTP9-original.jpg'
				}
			],
			tracking: null
		}
	],
    tracking: null
  },
  badges: {
    pro: false,
    creator_mid_tier: false,
    pro_unlimited: true,
    verified: true
  },
  station_urn: 'soundcloud:system-playlists:artist-stations:43969708',
  station_permalink: 'artist-stations:43969708'
}

export interface SoundcloudUser {
    avatar_url: string
    city: string
    comments_count: number
    country_code: number | null
    created_at: string
    creator_subscriptions: SoundcloudCreatorSubscription[]
    creator_subscription: SoundcloudCreatorSubscription
    description: string
    followers_count: number
    followings_count: number
    first_name: string
    full_name: string
    groups_count: number
    id: number
    kind: string
    last_modified: string
    last_name: string
    likes_count: number
    playlist_likes_count: number
    permalink: string
    permalink_url: string
    playlist_count: number
    reposts_count: number | null
    track_count: number
    uri: string
    urn: string
    username: string
    verified: boolean
    visuals: {
        urn: string
        enabled: boolean
        visuals: SoundcloudVisual[]
        tracking: null
    }
}



Other info:

The wavform URL contains the hash of the audio file
"waveform_url": "https://wave.sndcdn.com/q5IowznAbLiC_m.json",
hash: q5IowznAbLiC

The album endpoint is unreliable, only use it to get track ids

artist "visuals" are their banner