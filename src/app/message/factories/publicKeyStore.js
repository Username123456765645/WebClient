import _ from 'lodash';

import { CONTACT_ERROR, TIME, KEY_FLAGS } from '../../constants';
import { toList } from '../../../helpers/arrayHelper';
import { getGroup } from '../../../helpers/vcard';

/* @ngInject */
function publicKeyStore($rootScope, addressesModel, keyCache, pmcw, contactEmails, Contact, contactKey) {
    const CACHE = {};
    const CACHE_TIMEOUT = TIME.HOUR;
    const usesDefaults = (contactEmail) => !contactEmail || contactEmail.Defaults;

    const normalizeEmail = (email) => email.toLowerCase();

    /**
     * Filters the given list of key by fingerprint using an object representing the blacklist
     * @param {Array} keys An array of openpgp keys
     * @param {Object} blacklist An object that contains keys for each fingerprint that is blacklisted
     * @param An array of openpgp.js keys filtered by the given blacklist
     * @return {Array} The openpgp.js keys filtered by the passed in blacklist
     */
    const filterFingerprints = (keys, blacklist) => {
        return keys.filter(({ primaryKey }) => {
            return !blacklist[primaryKey.getFingerprint()];
        });
    };

    /**
     * Retrieve the public keys of a email address from cache. This returns either a map from email -> public keys
     * or null in case there is no such value
     * @param string email
     * @return {} Map email -> public keys OR NULL
     */
    const fromCache = (email, verificationOnly) => {
        const normEmail = normalizeEmail(email);
        if (!_.has(CACHE.EMAIL_PUBLIC_KEY, normEmail)) {
            return null;
        }

        const { timestamp, pubKeys, compromisedKeys } = CACHE.EMAIL_PUBLIC_KEY[normEmail];

        if (timestamp + CACHE_TIMEOUT < Date.now()) {
            delete CACHE.EMAIL_PUBLIC_KEY[normEmail];
            return null;
        }

        if (verificationOnly) {
            return { [email]: filterFingerprints(pubKeys, compromisedKeys) };
        }
        return { [email]: pubKeys };
    };

    const fromContacts = async (email) => {
        const normEmail = normalizeEmail(email);
        const contactEmail = contactEmails.findEmail(normEmail, normalizeEmail);

        if (usesDefaults(contactEmail)) {
            // fallback to api keys
            return;
        }

        const contact = await Contact.get(contactEmail.ContactID);

        const keyList = toList(contact.vCard.get('key'));
        const emailList = toList(contact.vCard.get('email'));

        const group = getGroup(emailList, normEmail);
        if (!group) {
            // fallback to api keys
            return;
        }

        const matchesGroup = (prop) => prop.getGroup() === group;

        const emailKeys = _.filter(keyList, matchesGroup);
        if (!emailKeys.length) {
            // fallback to api keys
            return;
        }
        if (contact.errors.includes(CONTACT_ERROR.TYPE2_CONTACT_VERIFICATION)) {
            // keys can't be trusted: the user has no keys. DO NOT fallback to api keys.
            return [contactEmail.ContactID, []];
        }
        const {
            [email]: { Keys }
        } = await keyCache.get([email]);
        const compromisedKeys = Keys.reduce((acc, { PublicKey, Flags }) => {
            if (!(Flags & KEY_FLAGS.ENABLE_VERIFICATION)) {
                const [{ primaryKey }] = pmcw.getKeys(PublicKey);
                acc[primaryKey.getFingerprint()] = true;
            }
            return acc;
        }, {});
        // In case the pgp packet list contains multiple keys, only first one is taken.
        const publicKeys = emailKeys.reduce((acc, emailKey) => {
            const [k = null] = contactKey.parseKey(emailKey);
            k && acc.push(k);
            return acc;
        }, []);

        return [contactEmail.ContactID, publicKeys, compromisedKeys];
    };

    const isOwnAddress = (email) =>
        _.map(addressesModel.get(), 'Email').includes(email.toLowerCase().replace(/\+[^@]*@/, ''));

    /**
     * Retrieves the pinned keys from the ProtonMail API
     * @param email The mail for which to return the pinned keys
     * @param verificationOnly True if we should remove compromised keys from the result
     * @return {Promise} A promise returning a map from email to a list of armored keys.
     */
    const fromApi = async (email, verificationOnly) => {
        _.map(addressesModel.get(), 'Email').includes(email.toLowerCase().replace(/\+[^@]*@/, ''));
        const normEmail = email.toLowerCase();
        // fetch keys from contacts and from api
        // we don't support key pinning on own addresses.
        if (!isOwnAddress(normEmail)) {
            const contactResult = await fromContacts(normEmail);
            if (contactResult) {
                const [contactID, contactKeyList, compromisedKeys] = contactResult;
                CACHE.EMAIL_PUBLIC_KEY[normEmail] = {
                    timestamp: Date.now(),
                    pubKeys: contactKeyList,
                    compromisedKeys,
                    contactID
                };
                if (verificationOnly) {
                    return { [email]: filterFingerprints(contactKeyList, compromisedKeys) };
                }
                return { [email]: contactKeyList };
            }
            // only verify with pinned keys.
            return { [email]: [] };
        }
        const { Keys } = addressesModel.get().find(({ Email }) => Email === email);

        const { pubKeys, compromisedKeys } = Keys.reduce(
            (acc, { PrivateKey, Flags }) => {
                const [k] = pmcw.getKeys(PrivateKey);
                acc.pubKeys.push(k.toPublic());
                if (!(Flags & KEY_FLAGS.ENABLE_VERIFICATION)) {
                    acc.compromisedKeys[k.primaryKey.getFingerprint()] = true;
                }
                return acc;
            },
            { pubKeys: [], compromisedKeys: {} }
        );
        CACHE.EMAIL_PUBLIC_KEY[normEmail] = { timestamp: Date.now(), pubKeys, compromisedKeys };
        if (verificationOnly) {
            return { [email]: filterFingerprints(pubKeys, compromisedKeys) };
        }
        return { [email]: pubKeys };
    };
    /**
     * Retrieves the pinned keys for each given email address.
     * @param {Array} emails An array of emails for which we want to retrieve the pinned keys
     * @param {Boolean} verificationOnly Whether we want to remove any compromised keys from the result
     * @returns {Promise} A promise returning a map from email to a list of openpgp.js keys.
     */
    const get = async (emails = [], verificationOnly = false) => {
        // retrieve the normalized emails from cache -> remove any null values -> combine them in one object
        const cachedKeys = emails.reduce((acc, email) => {
            const cache = fromCache(email, verificationOnly);
            if (cache) {
                acc[email] = cache[email];
            }
            return acc;
        }, {});
        const uncachedEmails = _.filter(emails, (email) => !_.has(cachedKeys, email));
        return Promise.all(_.map(uncachedEmails, (email) => fromApi(email, verificationOnly)))
            .then((apiKeys) => _.extend({}, ..._.filter(apiKeys)))
            .then((apiKeys) => _.extend({}, cachedKeys, apiKeys));
    };

    const contactEvents = (events) => {
        // Find by emails (e.g. create, update):
        events
            .filter(({ Contact }) => Contact)
            .forEach(({ Contact: { ContactEmails } }) =>
                ContactEmails.forEach(({ Email }) => delete CACHE.EMAIL_PUBLIC_KEY[Email])
            );
        // Find by ID (e.g. delete):
        events.forEach(({ ID }) => {
            _.keys(CACHE.EMAIL_PUBLIC_KEY)
                .filter((email) => CACHE.EMAIL_PUBLIC_KEY[email].contactID === ID)
                .forEach((email) => delete CACHE.EMAIL_PUBLIC_KEY[email]);
        });
    };

    const contactUpdated = ({ ContactEmails }) =>
        ContactEmails.forEach(({ Email }) => delete CACHE.EMAIL_PUBLIC_KEY[Email]);

    $rootScope.$on('contacts', (event, { type, data: { events = [], contact = {} } = {} }) => {
        type === 'contactEvents' && contactEvents(events);
        type === 'contactUpdated' && contactUpdated(contact);
    });

    const clearCache = () => {
        CACHE.EMAIL_PUBLIC_KEY = {};
    };

    clearCache();

    $rootScope.$on('logout', () => {
        clearCache();
    });

    return { get };
}
export default publicKeyStore;
