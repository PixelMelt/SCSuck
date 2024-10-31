<img align="right" height="250" src="./logo.svg" alt="Logo">

# SCSuck
#### Sucks down songs so you dont have to!
This program downloads and keeps soundcloud artist folders up to date, think of it like [Deemon](https://github.com/digitalec/deemon) but for soundcloud.


\> scsuck
<br>
\> look inside
<br>
\> sucks


This program was made for linux and may get hung up on crazy filenames on other OS's
<br>
probably? maybe?

# Requirements
`ffmpeg` must be accessable via CLI

```BASH
sudo apt install ffmpeg
```

# Features
- encodes hifi downloads to .flac
- download specific artists
- held together with duck tape
- download any new releases from all artists you added
- tags downloaded files with correct metadata and covers
- uses a ridiculus amount of disk space
- full album folders, every song is tagged as a single or album
- no checks to stop it from using all of your disk space
- download all the people a user is following

# How to use
```BASH
git clone https://github.com/PixelMelt/SCSuck
cd SCSuck
npm i
*edit config.json in the src folder*
node src/index.js --help
```

# Roadmap
- backups probably
- detect deleted tracks/artists
- download bandcamp too? maybe out of scope