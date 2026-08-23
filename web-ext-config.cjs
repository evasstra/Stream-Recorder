module.exports = {
	ignoreFiles: [
		'src/**/*'
	],
	run: {
		startUrl: [
			'./lit-element.html',
			'about:debugging'
		]
	},
	build: {
		overwriteDest: true
	},
	ignoreFiles: [
		'*config.*',
		'icons/*.png',
		'**/*.webm',
		'Screenshots',
		'icons/*.png',
		'small.ogv',
		'**/!(manifest).json',
		'**/*.html',
		'trash',
		'src/lib',
		'src/content_scripts'
	]
};

