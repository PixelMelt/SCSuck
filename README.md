<img align="right" height="250" src="./logo.svg" alt="Logo">

# SCSuck
#### Sucks down songs so you dont have to!

SCSuck is a SoundCloud library downloader that helps you automatically download your entire SoundCloud music collection. Think of it like [Deemon](https://github.com/digitalec/deemon) but for soundcloud.

This tool lets you plug in an artist name and bulk download everything they've produced, it adds them to a database so that you can download new songs from every artist you've collected with a single command without needing to  manually enter names, all with with proper metadata and album artwork.
Perfect for backing up your SoundCloud following lists, and artist collections.

\> scsuck
<br>
\> look inside
<br>
\> sucks


This program was made for linux and may get hung up on crazy filenames on other OS's
<br>
probably? maybe? I havent tested it

# Features
- encodes hifi downloads to .flac
- download specific artists
- held together with duck tape
- download any new releases from all artists you added
- tags downloaded files with correct metadata and covers, should perfectly import to navidrome
- uses a ridiculus amount of disk space
- full album folders, every song is tagged as a single or album
- no checks to stop it from using all of your disk space
- download all the people a user is following
- download rate limiting

If you fail to see any of these features working, open an issue immidiately

# Requirements
`ffmpeg` must be accessable via CLI

For debian based systems:

```BASH
sudo apt install ffmpeg
```

You must provide a soundcloud user api key and put it in config.json

From: [Soundcloud.ts](https://github.com/Moebits/soundcloud.ts):
> Soundcloud has closed down their API applications, but you are still able to get your client id and oauth token by inspecting the network traffic.
> - Go to soundcloud.com and login (skip if you are already logged in)
> - Open up the dev tools (Right click -> inspect) and go to the Network tab
> - Go to soundcloud.com, and you should see a bunch of requests in the network tab
> - Find the request that has the name `session` (you can filter by typing `session` in the filter box) and click on it
> - Go to the Payload tab
> - You should see your client id in the Query String Parameters section, and your oauth token (`access_token`) in the Request Payload section


# How to use
```BASH
git clone https://github.com/PixelMelt/SCSuck
cd SCSuck
npm i
npm i https://github.com/PixelMelt/soundcloud.ts # make sure you have the latest api lib
*edit config.json in the src folder*
node src/index.js --help
```

# Roadmap
- backups probably
- detect deleted tracks/artists
- download bandcamp too? maybe out of scope
- locate other artist accounts from connections (and musicbrainz maybe)
- dont use child process
- command to remove artists from list
- a hard exclusion list so you dont re add someone by accident
- a web interface
- handle sets better
- multiple concurrent downloads (mught make sc server mad)

# Thanks
- to [Moebits](https://github.com/Moebits/) for their project [Soundcloud.ts](https://github.com/Moebits/soundcloud.ts)