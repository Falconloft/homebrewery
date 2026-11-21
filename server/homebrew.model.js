import mongoose   from 'mongoose';
import { nanoid } from 'nanoid';
import _          from 'lodash';
import zlib       from 'zlib';

const isValidImageSource = (src)=>{
	if(typeof src !== 'string') return false;
	if(src.startsWith('/') && !src.startsWith('//')) return true;

	try {
		const url = new URL(src);
		return url.protocol === 'https:' && Boolean(url.hostname);
	} catch {
		return false;
	}
};

const TextBoxSchema = new mongoose.Schema({
	content       : { type: String, default: '', maxlength: 20000 },
	fontFamily    : { type: String, default: 'sans-serif', maxlength: 128 },
	fontSize      : { type: Number, default: 12, min: 1, max: 200 },
	fontWeight    : { type: String, enum: ['normal', 'bold'], default: 'normal' },
	fontStyle     : { type: String, enum: ['normal', 'italic'], default: 'normal' },
	color         : { type: String, default: '#000000', match: /^#[0-9a-fA-F]{6}$/ },
	align         : { type: String, enum: ['left', 'center', 'right', 'justify'], default: 'left' },
	verticalAlign : { type: String, enum: ['top', 'middle', 'bottom'], default: 'top' },
	padding       : { type: Number, default: 0, min: 0, max: 100 }
}, { _id: false, strict: 'throw' });

const ImageObjectSchema = new mongoose.Schema({
	src : {
		type      : String,
		required  : true,
		maxlength : 2048,
		validate  : {
			validator : isValidImageSource,
			message   : 'Image source must be an HTTPS URL or a root-relative path'
		}
	},
	alt : { type: String, default: '', maxlength: 500 },
	fit : { type: String, enum: ['contain', 'cover', 'fill'], default: 'contain' }
}, { _id: false, strict: 'throw' });

const ShapeObjectSchema = new mongoose.Schema({
	kind : { type: String, enum: ['rect', 'ellipse', 'line'], required: true },
	fill : {
		type     : String,
		default  : 'transparent',
		validate : {
			validator : (value)=>value === 'transparent' || /^#[0-9a-fA-F]{6}$/.test(value),
			message   : 'Fill must be transparent or a six-digit hex color'
		}
	},
	stroke      : { type: String, default: '#000000', match: /^#[0-9a-fA-F]{6}$/ },
	strokeWidth : { type: Number, default: 1, min: 0, max: 72 }
}, { _id: false, strict: 'throw' });

const PageObjectSchema = new mongoose.Schema({
	id       : { type: String, required: true, default: ()=>nanoid(12), maxlength: 64, match: /^[a-zA-Z0-9_-]+$/ },
	type     : { type: String, enum: ['text', 'image', 'shape'], required: true },
	page     : { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'Page must be an integer' } },
	x        : { type: Number, required: true, default: 0, min: 0, max: 1 },
	y        : { type: Number, required: true, default: 0, min: 0, max: 1 },
	width    : { type: Number, required: true, min: 0, max: 1 },
	height   : { type: Number, required: true, min: 0, max: 1 },
	rotation : { type: Number, default: 0, min: -360, max: 360 },
	zIndex   : { type: Number, default: 0, min: 0, max: 1000, validate: { validator: Number.isInteger, message: 'zIndex must be an integer' } },
	visible  : { type: Boolean, default: true },
	locked   : { type: Boolean, default: false },

	textBox : { type: TextBoxSchema },
	image   : { type: ImageObjectSchema },
	shape   : { type: ShapeObjectSchema }
}, { _id: false, strict: 'throw' });

PageObjectSchema.pre('validate', function() {
	const payloads = {
		text  : this.textBox,
		image : this.image,
		shape : this.shape
	};
	const matchingPayload = payloads[this.type];

	if(!matchingPayload && Object.prototype.hasOwnProperty.call(payloads, this.type)) {
		this.invalidate(this.type === 'text' ? 'textBox' : this.type, `Payload required for ${this.type} objects`);
	}

	for (const [type, payload] of Object.entries(payloads)) {
		if(type !== this.type && payload != null) {
			this.invalidate(type, `Payload is not valid for ${this.type} objects`);
		}
	}

	const isLine = this.type === 'shape' && this.shape?.kind === 'line';
	if((!isLine && (this.width <= 0 || this.height <= 0)) ||
		(isLine && this.width <= 0 && this.height <= 0)) {
		this.invalidate('width', 'Object dimensions must be positive');
	}

	if(this.x + this.width > 1 || this.y + this.height > 1) {
		this.invalidate('width', 'Object bounds must fit within the page');
	}
});

const HomebrewSchema = mongoose.Schema({
	shareId   : { type: String, default: ()=>{return nanoid(12);}, index: { unique: true } },
	editId    : { type: String, default: ()=>{return nanoid(12);}, index: { unique: true } },
	googleId  : { type: String, index: true },
	title     : { type: String, default: '', index: true },
	text      : { type: String, default: '' },
	textBin   : { type: Buffer },
	pageCount : { type: Number, default: 1, index: true },

	description    : { type: String, default: '' },
	tags           : { type: [String], index: true },
	systems   		   : { type: [String], default: undefined },
	lang           : { type: String, default: 'en', index: true },
	renderer       : { type: String, default: '', index: true },
	authors        : { type: [String], index: true },
	invitedAuthors : [String],
	published      : { type: Boolean, default: false, index: true },
	thumbnail      : { type: String, default: '', index: true },

	createdAt  : { type: Date, default: Date.now, index: true },
	updatedAt  : { type: Date, default: Date.now, index: true },
	lastViewed : { type: Date, default: Date.now, index: true },
	views      : { type: Number, default: 0 },
	version    : { type: Number, default: 1, index: true },

	lock : { type: Object, index: true },

	pageObjects : {
		type     : [PageObjectSchema],
		default  : [],
		validate : [
			{
				validator : (objects)=>objects.length <= 500,
				message   : 'A brew may contain at most 500 page objects'
			},
			{
				validator : (objects)=>new Set(objects.map((object)=>object.id)).size === objects.length,
				message   : 'Page object IDs must be unique within a brew'
			},
			{
				validator : function(objects) {
					return objects.every((object)=>object.page <= this.pageCount);
				},
				message : 'Page object page must not exceed the brew page count'
			}
		]
	}
}, { versionKey: false });

HomebrewSchema.pre('save', function() {
	if(this.text !== undefined) {
		this.textBin = zlib.deflateRawSync(this.text);
		this.text = undefined;
	}
});

HomebrewSchema.statics.increaseView = async function(query) {
	const brew = await Homebrew.findOne(query).exec();
	brew.lastViewed = new Date();
	brew.views = brew.views + 1;
	await brew.save()
		.catch((err)=>{
			return err;
		});
	return brew;
};

// STATIC FUNCTIONS

HomebrewSchema.statics.get = async function(query, fields=null){
	const brew = await Homebrew.findOne(query, fields).orFail()
		.catch((error)=>{throw 'Can not find brew';});
	if(!_.isNil(brew.textBin)) {			// Uncompress zipped text field
		const unzipped = zlib.inflateRawSync(brew.textBin);
		brew.text = unzipped.toString();
		brew.textBin = undefined;
	}
	return brew;
};

HomebrewSchema.statics.getByUser = async function(username, allowAccess=false, fields=null, filter=null){
	const query = { authors: username, published: true, ...filter };
	if(allowAccess){
		delete query.published;
	}
	const brews = await Homebrew.find(query, fields).lean().exec() //lean() converts results to JSObjects
		.catch((error)=>{throw 'Can not find brews';});
	return brews;
};

// INDEXES

HomebrewSchema.index({ updatedAt: -1, lastViewed: -1 });
HomebrewSchema.index({ published: 1, title: 'text' });

HomebrewSchema.index({ lock: 1, sparse: true });
HomebrewSchema.path('lock.reviewRequested').index({ sparse: true });


const Homebrew = mongoose.model('Homebrew', HomebrewSchema);

export {
	HomebrewSchema as schema,
	Homebrew       as model
};
