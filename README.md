# Casino

Blackjack, roulette française et poker pour iPhone, installables sur l'écran d'accueil (Safari → Partager → « Sur l'écran d'accueil »).
Fonctionne hors ligne après la première ouverture. Le solde est partagé entre tous les jeux.

- **Blackjack** : sabot de 6 jeux, blackjack payé 3 pour 2, le croupier reste sur 17, doubler sur deux cartes, séparer jusqu'à 4 mains.
- **Roulette** : un seul zéro, plein 35 pour 1, douzaines et colonnes 2 pour 1, chances simples 1 pour 1, règle de la partage sur le zéro.
- **Poker** : Texas Hold'em no limit contre 3 bots (blindes 10/20, tapis = ton solde), et vidéo poker Jacks or Better 9/6.
- **Poker en ligne** : Texas Hold'em de 2 à 6 joueurs entre amis (onglet Poker → En ligne). Une personne crée la table et partage le code de 5 caractères, les autres le saisissent. Connexion directe entre téléphones (PeerJS / WebRTC), sans compte ni serveur à gérer. Jetons de table séparés du solde du casino. Les modes hors ligne restent disponibles sans réseau.
- **Comptes, historique et classement** : pseudo + mot de passe (sans email), historique de toutes les parties, classement entre amis et classement général par gains nets. Données dans Supabase (script : `supabase/schema.sql`). Les parties jouées hors ligne sont envoyées au retour du réseau.
- **Invitations par QR code** : chaque joueur a un QR code personnel (Classement → Mon QR code). Le scanner ouvre l'app, propose de l'installer et rend les deux joueurs amis. Scanner intégré et saisie du code possibles. Mise à jour serveur : `supabase/invitations.sql`.
- **Boutique et récompenses** : couronnes, bannières, cadres et titres pour personnaliser sa carte de joueur. Chaque lundi, le classement général de la semaine (10 parties minimum) rapporte des couronnes et des objets exclusifs au podium. Mise à jour serveur : `supabase/boutique.sql`.
- **Saisons mensuelles** : points de saison, rangs Bronze → Fer → Argent → Platine → Diamant → Alexandrite → Top 100, récompenses de fin de saison et champion de la saison. Profils publics, réglages du compte (pseudo, mot de passe, suppression), activité en direct, écran de lancement. Mise à jour serveur : `supabase/saisons.sql`.
- **Joueurs automatiques (temporaires)** : `supabase/saisons.sql` crée 16 bots qui jouent en continu pour animer les classements. Pour les retirer : `supabase/supprimer_bots.sql`.
- **Casier, boutique tournante, photos** : onglet Casier (tous ses objets, recherche par nom, rareté, photo de profil), boutique différente chaque semaine, objets de saison numérotés propres à chaque rang et chaque saison, rang Or, couronne et titre de la semaine transmis au n°1, recherche de joueurs, mises en page téléphone / tablette / ordinateur. Mise à jour serveur : `supabase/casier.sql`.
- **Catalogue étendu et saisons cumulées** : 58 objets de plus en boutique (24 bannières, 14 cadres, 20 titres) ; en fin de saison, chacun reçoit les récompenses de son rang et de tous les rangs en dessous. Mise à jour serveur : `supabase/catalogue.sql`.
- **Aide intégrée** : bouton « ? » en haut de chaque page avec les règles du jeu (blackjack, roulette, Hold'em, vidéo poker, poker en ligne, classement, boutique), ouvertes automatiquement la première fois.
- **Défis et connexion quotidienne** : 3 défis par jour (+ bonus de 50 couronnes) et série de connexion 5/5/5/20/20/20/50 couronnes. Mise à jour serveur : `supabase/defis.sql`. L'app occupe toute la hauteur de l'iPhone et reste en portrait quand on tourne le téléphone.
- **Onglets Jeux, Défis et Rangs** : un onglet Jeux ouvre le choix du jeu ; les défis et les rangs ont leur propre onglet ; le rang repart de zéro à chaque saison. **Sabot de cartes** au blackjack (cartes restantes, mélange, aide au comptage Hi-Lo en option) et taille du paquet au poker.
