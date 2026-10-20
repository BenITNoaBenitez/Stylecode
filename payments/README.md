# Paiements des particuliers

Le site utilise des liens de paiement hébergés par Stripe. Aucun serveur de paiement ni clé secrète n'est chargé par le navigateur. `config.js` ne contient que des URL publiques.

## État actuel

Vérification du compte Cal.com `natalia-ventura-stylecode` le 20 octobre 2026 : huit variantes sont associées dans `bookings/config.js`. Le rendez-vous gratuit `30min` est réservé aux appels Entreprises.

| Variante du site | Événement Cal.com | Tarif configuré | Stripe activé dans les métadonnées |
| --- | --- | --- | --- |
| Stylecode visio | `stylecode-decodez-votre-style-en-ligne` | 160 € | Non renseigné |
| Stylecode présentiel | `decodez-votre-style` | 180 € | Oui |
| Morphologie visio | `morphologie-visagisme-en-ligne` | 160 € | Non renseigné |
| Morphologie présentiel | `morphologie-visagisme` | 180 € | Oui |
| Colorimétrie visio | `colorimetrie` | 69 € | Oui |
| Colorimétrie présentiel | `colorimetrie-en-presentiel` | 85 € | Non renseigné |
| Moodboard | `moodboard-stylecode` | 60 € | Oui |
| Édition de dressing | `edition-de-dressing` | 90 € | Oui |

Les anciens événements Stylecode et Morphologie sont désormais à 180 € : les boutons visio à 160 € utilisent leurs nouveaux événements dédiés. Tous les événements indiquent encore Cal Video comme lieu, y compris les trois variantes associées au présentiel. Leur lieu doit être corrigé dans Cal.com. Les trois événements sans métadonnées Stripe nécessitent une vérification de l’activation du paiement ; le prix configuré seul ne prouve pas qu’un paiement sera demandé.

Ces réservations Cal.com ont priorité sur les Payment Links autonomes ci-dessous : le client choisit son créneau puis effectue le paiement si celui-ci est activé dans Cal.com, sans second paiement sur le site. Les deux packs n’apparaissent pas parmi les dix événements retournés par le compte. L’événement `carte-cadeau` est un rendez-vous gratuit de 90 minutes, sans paiement ni montant libre : il n’est donc pas utilisé comme lien d’achat. Les packs et la carte cadeau restent par e-mail tant que leur parcours propre n’est pas configuré. Les boutons génériques des particuliers mènent au choix des prestations, pas au rendez-vous gratuit Entreprises.

Les 8 produits et leurs 11 variantes sont préparés dans `catalog.json`. Les montants sont en centimes : Stylecode et morphologie à 160 € en visio / 180 € en présentiel, colorimétrie à 69 € / 85 €, Moodboard à partir de 60 €, dressing à partir de 90 €, packs à partir de 200 € et 450 €, carte cadeau à montant libre (minimum 1 €).

Le mode `disabled` et les liens `null` conservent les demandes par e-mail pour les offres sans rendez-vous Cal.com. Chaque variante dispose de son propre lien. Une offre peut être activée indépendamment des autres.

Les tarifs définitifs du Moodboard, du dressing et des deux packs restent à confirmer : leur montant « à partir de » ne vaut pas encore validation d'un prix fixe. Le pack Stylecode est préparé pour un paiement comptant ; le paiement en plusieurs fois reste à convenir directement avec Natalia, sans abonnement ni échéancier automatique créé.

## Créer les liens

Avec la connexion Stripe, créer les produits, prix et Payment Links correspondant au catalogue, puis reporter les liens dans `config.js`. Les variantes doivent être identifiables sur la page de paiement. Pour la carte cadeau, utiliser un prix `custom_unit_amount` : le montant se choisit sur Stripe.

L'alternative locale utilise Node 20 ou ultérieur, sans dépendance :

```sh
# Aperçu hors ligne ; aucun objet Stripe créé.
node scripts/prepare-stripe.mjs

# STRIPE_SECRET_KEY doit être définie dans l'environnement local.
# Créer les objets de test et générer la configuration de prévisualisation.
node scripts/prepare-stripe.mjs --apply

# Une fois les tarifs confirmés, avec une clé de production.
node scripts/prepare-stripe.mjs --apply --live --prices-confirmed
```

Ne jamais mettre de clé secrète dans le dépôt, le HTML ou `config.js`. Le script enregistre les identifiants créés dans `.stripe/` (ignoré par Git), reprend après une interruption et utilise des clés d'idempotence. Conserver cet état pour éviter de recréer les objets. Il refuse de réutiliser l'état d'un autre compte ou d'un catalogue modifié.

Le mode `test` est volontairement inactif sur un domaine public. Le mode `live` n'accepte que des liens de production `https://buy.stripe.com/...` ou `https://book.stripe.com/...`. Un lien absent ou invalide conserve la réservation par e-mail. Les pages ouvertes directement en `file://` sont prises en charge.

## Après le paiement

Pour les huit variantes associées, Cal.com gère le choix du créneau et la confirmation du rendez-vous. Le paiement Stripe dépend de son activation dans chaque événement (voir l’état ci-dessus).

Pour les Payment Links autonomes, Stripe affiche sa confirmation hébergée. Le site ne confirme aucun paiement à partir d'un paramètre d'URL. Les liens portent la référence de la variante pour le rapprochement. Natalia vérifie le paiement dans Stripe puis organise la séance ou la carte cadeau ; aucune émission de carte cadeau ni prise de rendez-vous automatique n'est annoncée pour ce parcours distinct.

Tests locaux : `node --test tests/payments.test.mjs`.

Documentation : [Payment Links](https://docs.stripe.com/payment-links/create), [montants libres](https://docs.stripe.com/products-prices/how-products-and-prices-work#variable-pricing), [idempotence](https://docs.stripe.com/api/idempotent_requests).
